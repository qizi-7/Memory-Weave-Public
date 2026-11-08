const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash,createDecipheriv} = require('node:crypto');
const {spawn} = require('node:child_process');

const magic = Buffer.from([7,8,86,50,8,7]);
const isV2 = bytes => bytes.subarray(0,6).equals(magic);
const isWxgf = bytes => bytes.subarray(0,4).toString() === 'wxgf';
const localCodes = new Map();

async function imageCodes(root) {
  const cached=localCodes.get(root);
  if(cached && cached.expires>Date.now()) return cached.codes;
  const base=path.dirname(path.dirname(root));
  const directories=[
    path.join(base,'app_data/net/kvcomm'),
    path.join(base,'xwechat/net/kvcomm'),
    path.join(base,'../Library/Application Support/com.tencent.xinWeChat/xwechat/net/kvcomm'),
    path.join(base,'../Library/Application Support/com.tencent.xinWeChat/net/kvcomm')
  ];
  const names=(await Promise.all(directories.map(dir=>fs.readdir(dir).catch(()=>[])))).flat();
  const codes=[...new Set(names.map(name=>Number(/^key_(\d+)_.+\.statistic$/i.exec(name)?.[1]))
    .filter(code=>Number.isInteger(code)&&code>0&&code<=0xffffffff))].slice(0,64);
  localCodes.set(root,{codes,expires:Date.now()+120000});
  return codes;
}

async function decryptV2(root, bytes, recognize) {
  if (bytes.length<31) return null;
  const aesLength=bytes.readUInt32LE(6);
  const tailLength=bytes.readUInt32LE(10);
  const split=15+16*(Math.floor(aesLength/16)+1);
  const tail=bytes.length-tailLength;
  if (split>tail) return null;
  const directory=path.basename(root);
  const account=/^(wxid_[^_]+)/i.exec(directory)?.[1] || directory.replace(/_[A-Za-z0-9]{4}$/,'');
  for (const code of await imageCodes(root)) {
    const key=createHash('md5').update(String(code)+account).digest('hex').slice(0,16);
    try {
      const decipher=createDecipheriv('aes-128-ecb',Buffer.from(key),null);
      const first=Buffer.concat([decipher.update(bytes.subarray(15,split)),decipher.final()]);
      if(first.length!==aesLength) continue;
      const decoded=Buffer.concat([first,bytes.subarray(split,tail),bytes.subarray(tail).map(byte=>byte^(code&255))]);
      if (recognize(decoded) || isWxgf(decoded)) return decoded;
    } catch { /* Invalid padding rejects an unrelated cache key. */ }
  }
  return null;
}

function stickerStream(bytes) {
  if (!isWxgf(bytes) || bytes.length < 25 || bytes[4] < 5 || bytes[4] >= bytes.length) return null;
  // Decode the complete HEVC sequence from its VPS, not the first length-delimited frame.
  const startCode=Buffer.from([0,0,1]);
  for(let at=bytes[4];(at=bytes.indexOf(startCode,at))>=0;at+=3) {
    if(at+5>=bytes.length)break;
    if(((bytes[at+3]>>1)&63)===32 && (bytes[at+4]&7)!==0)
      return bytes.subarray(at>0&&bytes[at-1]===0?at-1:at);
  }
  return null;
}
async function decryptStickerCache(root,bytes){
  if(bytes.length<16 || bytes.length>8*1024*1024 || bytes.length%16!==0)return null;
  const directory=path.basename(root);
  const account=/^(wxid_[^_]+)/i.exec(directory)?.[1]||directory.replace(/_[A-Za-z0-9]{4}$/,'');
  // Only the caller's exact hash-addressed Emoticon cache uses this key domain.
  for(const code of (await imageCodes(root)).slice(0,16)){
    const key=createHash('md5').update(String(code)+account+'EMOTICON').digest();
    try{
      const head=createDecipheriv('aes-128-cbc',key,key);
      head.setAutoPadding(false);
      if(!isWxgf(head.update(bytes.subarray(0,16))))continue;
      const decipher=createDecipheriv('aes-128-cbc',key,key);
      const plain=Buffer.concat([decipher.update(bytes),decipher.final()]);
      if(stickerStream(plain))return plain;
    }catch{/* Different cache code or invalid padding. */}
  }
  return null;
}
function renderStickerWxgf(bytes,ffmpeg,timingScale=1){
  const stream=ffmpeg&&stickerStream(bytes);
  if(!stream)return Promise.resolve(null);
  return new Promise(resolve=>{
    const child=spawn(ffmpeg,['-nostdin','-hide_banner','-loglevel','error','-xerror','-threads','2',
      '-f','hevc','-i','pipe:0','-vf','scale=480:480:force_original_aspect_ratio=decrease',
      '-frames:v','601','-fps_mode','passthrough','-loop','0','-progress','pipe:2','-f','gif','pipe:1'],{stdio:['pipe','pipe','pipe']});
    const chunks=[];let length=0,status='',failed=false;
    const stop=()=>{failed=true;child.kill('SIGKILL')};
    const timer=setTimeout(stop,12000);
    child.stdout.on('data',chunk=>{length+=chunk.length;if(length>16*1024*1024)stop();else chunks.push(chunk)});
    child.stderr.on('data',chunk=>{status=(status+String(chunk)).slice(-16384)});
    child.stdin.on('error',()=>{});
    child.on('error',()=>{clearTimeout(timer);resolve(null)});
    child.on('close',code=>{
      clearTimeout(timer);
      const frames=Number([...status.matchAll(/^frame=([0-9]+)$/gm)].at(-1)?.[1]);
      const result=!failed&&code===0&&frames>0&&frames<=600?Buffer.concat(chunks):null;
      try{resolve(result?.subarray(0,6).toString()==='GIF89a'&&result.at(-1)===0x3b?require('./gif-timing.cjs').gifTiming(result,timingScale).bytes:null)}catch{resolve(null)}
    });
    child.stdin.end(stream);
  });
}

async function unwrapWxgf(bytes, ffmpeg, recognize) {
  if (!isWxgf(bytes)) return bytes;
  const prefix=bytes.subarray(4,4096);
  for (const signature of [Buffer.from('ffd8ff','hex'),Buffer.from('89504e470d0a1a0a','hex')]) {
    const offset=prefix.indexOf(signature);
    if (offset>=0 && recognize(bytes.subarray(offset+4))) return bytes.subarray(offset+4);
  }
  if (!ffmpeg) return null;
  const marker=Buffer.from([0,0,0,1]);
  let largest,offset=bytes[4];
  while ((offset=bytes.indexOf(marker,offset))>=0) {
    const length=offset>=4?bytes.readUInt32BE(offset-4):0;
    if (length>4 && length<=bytes.length-offset) {
      if (!largest || length>largest.length) largest=bytes.subarray(offset,offset+length);
      offset+=length;
    } else offset+=4;
  }
  const start=prefix.indexOf(marker);
  const stream=largest || (start>=0 && bytes.subarray(start+4));
  if (!stream) return null;
  return new Promise(resolve=>{
    const child=spawn(ffmpeg,['-hide_banner','-loglevel','error','-threads','2','-f','hevc','-i','pipe:0','-frames:v','1','-vf','scale=1600:1600:force_original_aspect_ratio=decrease','-c:v','png','-f','image2pipe','pipe:1'],{stdio:['pipe','pipe','ignore']});
    const chunks=[];let length=0;
    const timer=setTimeout(()=>child.kill(),12000);
    child.stdout.on('data',chunk=>{
      length+=chunk.length;
      if(length>16*1024*1024) child.kill();
      else chunks.push(chunk);
    });
    child.stdin.on('error',()=>{});
    child.on('error',()=>{clearTimeout(timer);resolve(null)});
    child.on('close',code=>{clearTimeout(timer);resolve(code===0?Buffer.concat(chunks):null)});
    child.stdin.end(stream);
  });
}
module.exports={isV2,isWxgf,invalidateImageCodes:root=>localCodes.delete(root),decryptV2,unwrapWxgf,imageCodes,decryptStickerCache,renderStickerWxgf};
