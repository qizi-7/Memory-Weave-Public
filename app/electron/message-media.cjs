const fs = require('node:fs/promises');
const {constants} = require('node:fs');
const {createHash} = require('node:crypto');
const path = require('node:path');
const {Readable} = require('node:stream');
const {isV2,isWxgf,decryptV2,unwrapWxgf,imageCodes,decryptStickerCache,renderStickerWxgf} = require('./wechat-image.cjs');
const {messageContent} = require('./message-content.cjs');

const mediaScheme = 'mw-media';
const missing = () => new Response(null,{status:404,headers:{'cache-control':'no-store'}});
const accountFor = root => 'wechat:'+createHash('sha256').update(root).digest('hex');
const signatures = {
  image: [
    ['image/png',0,Buffer.from('89504e470d0a1a0a','hex')],
    ['image/jpeg',0,Buffer.from('ffd8ff','hex')],
    ['image/gif',0,Buffer.from('GIF87a')],
    ['image/gif',0,Buffer.from('GIF89a')],
    ['image/webp',8,Buffer.from('WEBP')]
  ],
  video: [['video/mp4',4,Buffer.from('ftyp')]],
  audio: [
    ['audio/wav',8,Buffer.from('WAVE')],
    ['audio/ogg',0,Buffer.from('OggS')],
    ['audio/mpeg',0,Buffer.from('ID3')]
  ]
};
function identify(header, mode, legacyDat) {
  for (const [mime,offset,signature] of signatures[mode]) {
    if (header.length < offset + signature.length) continue;
    const xor = legacyDat ? header[offset] ^ signature[0] : 0;
    if (!signature.every((byte,i)=>(header[offset+i]^xor)===byte)) continue;
    if (offset===8 && !Buffer.from(header.subarray(0,4).map(byte=>byte^xor)).equals(Buffer.from('RIFF'))) continue;
    return {mime,xor};
  }
}
const fault=(reason,stage)=>Object.assign(Error(reason),{reason,stage});
const temporary=new Set(['EAGAIN','EBUSY','EINTR','ESTALE','ETIMEDOUT']);
async function safeOpen(root, relative) {
  const filename=path.resolve(root,relative);
  if(!filename.startsWith(root+path.sep))throw fault('pathRejected','path');
  for(let attempt=0;attempt<3;attempt++){
    let handle,seen=false;
    try{
      if(await fs.realpath(filename)!==filename)throw fault('pathRejected','path');
      seen=true;
      handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      const stat=await handle.stat();
      if(!stat.isFile())throw fault('pathRejected','path');
      if(!stat.size)throw fault('fileNotReady','open');
      const current=await fs.lstat(filename);
      if(current.dev!==stat.dev||current.ino!==stat.ino||await fs.realpath(filename)!==filename)throw fault('fileNotReady','open');
      return {handle,size:stat.size};
    }catch(e){
      await handle?.close().catch(()=>{});
      if(e.reason==='pathRejected'||e.code==='ELOOP')throw fault('pathRejected','path');
      if(!seen&&['ENOENT','ENOTDIR'].includes(e.code))return;
      if(e.reason==='fileNotReady'||temporary.has(e.code)||seen&&e.code==='ENOENT'){
        if(attempt<2){await new Promise(r=>setTimeout(r,attempt?120:40));continue;}
        throw fault('fileNotReady','open');
      }
      throw fault(e.code==='EACCES'||e.code==='EPERM'?'filePermission':'fileUnreadable','open');
    }
  }
}
// WeChat 4.x Emoticon cache: flat filenames under the MD5 prefix, no network lookup.
async function stickerCache(root,month,keys){
  const cache=path.join(root,'cache');
  try{
    if(await fs.realpath(cache)!==cache)return [];
    const months=(await fs.readdir(cache,{withFileTypes:true})).filter(entry=>entry.isDirectory()&&/^\d{4}-\d{2}$/.test(entry.name)).map(entry=>entry.name).sort().reverse();
    return [...new Set([month,...months.slice(0,120)])].flatMap(part=>keys.filter(key=>/^[a-f0-9]{32}$/.test(key))
      .map(key=>path.join('cache',part,'Emoticon',key.slice(0,2),key)));
  }catch{return [];}
}
async function resolveAsset(root,row,slot,{links=[],voice,ffmpeg,timingScale=1,diagnostics={}}={}) {
  const {type,hashes=[],datName,remoteHint} = messageContent(row);
  diagnostics.stage='metadata';
  const expectedSizes=new Map();
  const readable=result=>{diagnostics.reason=null;diagnostics.stage='resolved';return result;};
  const keys = [...new Set([...hashes,...(datName?[datName.replace(/\.dat$/i,'').toLowerCase()]:[])])];
  if (!Number.isFinite(row.ts)) return null;
  const date = new Date(row.ts * 1000);
  if (!Number.isFinite(date.getTime())) return null;
  const month = date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0');
  const chat = /^unresolved:[a-f0-9]{32}$/.test(row.chat) ? row.chat.slice(11) : createHash('md5').update(row.chat).digest('hex');
  let candidates, mode;
  if (slot === 'preview' && (type === 'image' || type === 'sticker')) {
    mode = 'image';
    const dirs = [
      path.join('cache',month,'Message',chat,'Bubble'),
      ...['Img','Image','image'].map(dir=>path.join('msg','attach',chat,month,dir)),
      ...(type==='sticker'?[path.join('msg','emoji'),path.join('cache','emoji')]:[])
    ];
    const variants = ['_t.dat','_thumb.dat','_t_M.dat','_b.dat','_w.dat','_c.dat','.dat','.jpg','.jpeg','.png','.webp','.gif'];
    candidates = dirs.flatMap(dir=>keys.flatMap(key=>variants.map(ext=>path.join(dir,key+ext))));
    if(type==='sticker'&&keys.length)candidates.unshift(...await stickerCache(root,month,keys));
    for (const {first,second,file_name:name} of links) {
      if (typeof first!=='string' || typeof name!=='string' || !/^[a-f0-9]{32}$/i.test(first) || !/^\d{4}-\d{2}$/.test(second) || !/^[a-f0-9]{32}\.dat$/i.test(name)) continue;
      const directory=path.join('msg','attach',first,second,'Img');
      candidates.unshift(...['_t.dat','_thumb.dat','.dat'].map(ext=>path.join(directory,name.slice(0,-4)+ext)));
    }
  } else if (type === 'video' && (['preview','play','frame'].includes(slot))) {
    mode = slot === 'preview' ? 'image' : 'video';
    const variants = slot === 'preview' ? ['_thumb.jpg','.jpg','_raw_thumb.jpg','_raw.jpg'] : ['.mp4','_raw.mp4'];
    candidates = keys.flatMap(key=>variants.map(ext=>path.join('msg','video',month,key+ext)));
    for (const {first,file_name:name} of links) {
      if (typeof first!=='string' || typeof name!=='string' || !/^\d{4}-\d{2}$/.test(first) || !/^[a-f0-9]{32}(?:_raw)?\.mp4$/i.test(name)) continue;
      const key=name.replace(/(?:_raw)?\.mp4$/i,'');
      candidates.unshift(...variants.map(ext=>path.join('msg','video',first,key+ext)));
    }
  } else if (type === 'voice' && slot === 'play') {
    mode = 'audio';
    candidates = keys.flatMap(key=>['.wav','.ogg','.mp3'].map(ext=>path.join('msg','voice',month,key+ext)));
  } else {diagnostics.reason='formatUnsupported';return null;}
  // Only an exact message_resource association supplies these references.
  // Names and sizes are revalidated at the final filesystem boundary.
  for(const {resource:r} of links) {
    if(!r || !/^[a-f0-9]{32}$/.test(r.id) || r.chatHash!==chat || !/^\d{4}-\d{2}$/.test(r.month) || r.month!==month)continue;
    const variants=type==='image'&&slot==='preview'?
      [['_t.dat','thumbnail'],['_thumb.dat','thumbnail'],['.dat','original']]:
      type==='video'&&slot==='preview'?[['_thumb.jpg','thumbnail']]:
      type==='video'&&['play','frame'].includes(slot)?[['.mp4','original'],['_raw.mp4','original']]:[];
    for(const [extension,role] of variants) {
      const size=r.sizes?.[role];if(!Number.isSafeInteger(size)||size<=0)continue;
      const relative=type==='image'?path.join('msg','attach',chat,r.month,'Img',r.id+extension):path.join('msg','video',r.month,r.id+extension);
      candidates.unshift(relative);expectedSizes.set(relative,size);
    }
  }
  diagnostics.reason=type==='sticker'&&remoteHint?'stickerRemoteOnly':keys.length||links.length?'resourceMissing':'metadataMissing';
  if(type==='video'&&slot==='preview')diagnostics.reason='videoPreviewMissing';
  diagnostics.stage=keys.length||links.length?'index':'metadata';
  const rank={metadata:0,index:1,path:2,open:3,header:4,decrypt:5,decode:6};
  const problem=(reason,stage)=>{if(rank[stage]>=rank[diagnostics.stage])Object.assign(diagnostics,{reason,stage});};
  for (const relative of new Set(candidates)) {
    let asset;
    try {
      asset = await safeOpen(root,relative);
      if (!asset) continue;
      if(expectedSizes.has(relative)&&asset.size!==expectedSizes.get(relative)){problem('resourceSizeMismatch','open');continue;}
      if(slot==='frame'&&asset.size>256*1024*1024){problem('frameSizeLimit','open');continue;}
      const header = Buffer.alloc(16);
      const {bytesRead} = await asset.handle.read(header,0,header.length,0);
      if (mode==='image' && isV2(header)) {
        if (asset.size>32*1024*1024){problem('imageSizeLimit','open');continue;}
        problem((await imageCodes(root)).length?'decryptFailed':'imageKeyMissing','decrypt');
        const raw=await asset.handle.readFile();
        const recognize=bytes=>identify(bytes,'image',false);
        const plain=await decryptV2(root,raw,recognize);
        if (plain) {
          const decoded=type==='sticker'&&isWxgf(plain)?await renderStickerWxgf(plain,ffmpeg,timingScale):await unwrapWxgf(plain,ffmpeg,recognize);
          const format=decoded && recognize(decoded);
          if (format) {diagnostics.decrypted=true;return readable({bytes:decoded,size:decoded.length,mime:format.mime});}
          problem(ffmpeg?'decodeFailed':'decoderUnavailable','decode');
        }
        continue;
      }
      if(type==='sticker' && (isWxgf(header)||(
        /^cache[\/]\d{4}-\d{2}[\/]Emoticon[\/][a-f0-9]{2}[\/][a-f0-9]{32}$/.test(relative) &&
        asset.size%16===0 && asset.size<=8*1024*1024 && !identify(header,'image',false)
      ))){
        if(asset.size>8*1024*1024){problem('imageSizeLimit','open');continue;}
        const raw=await asset.handle.readFile();
        const alreadyPlain=isWxgf(raw);
        const plain=alreadyPlain?raw:await decryptStickerCache(root,raw);
        if(plain){
          const decoded=await renderStickerWxgf(plain,ffmpeg,timingScale);
          if(decoded){diagnostics.decrypted=!alreadyPlain;return readable({bytes:decoded,size:decoded.length,mime:'image/gif'});}
          problem(ffmpeg?'decodeFailed':'decoderUnavailable','decode');continue;
        }
      }
      if(mode==='image'&&isWxgf(header)){
        if(asset.size>32*1024*1024){problem('imageSizeLimit','open');continue;}
        const recognize=bytes=>identify(bytes,'image',false);
        const decoded=await unwrapWxgf(await asset.handle.readFile(),ffmpeg,recognize);
        const format=decoded&&recognize(decoded);
        if(format)return readable({bytes:decoded,size:decoded.length,mime:format.mime});
        problem(ffmpeg?'decodeFailed':'decoderUnavailable','decode');continue;
      }
      const format = identify(header.subarray(0,bytesRead),mode,mode==='image' && relative.endsWith('.dat'));
      if(!format)problem('formatUnsupported','header');
      if (format && (!format.xor || asset.size <= 32*1024*1024)) {
        const result={...asset,...format};asset=null;return readable(result);
      }
    } catch(error) {
      problem(error.reason||'fileUnreadable',error.stage||'open');
    } finally {
      await asset?.handle.close().catch(()=>{});
    }
  }
  if (mode==='audio' && voice) {
    try {
      const bytes=await voice();
      if (bytes?.length) return readable({bytes,size:bytes.length,mime:'audio/wav'});
    } catch { problem('voiceUnreadable','decode'); }
  }
  return null;
}
function byteRange(value, size) {
  if (!value) return [0,size-1];
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0,size-Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size-1,Number(match[2])) : size-1;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end ? [start,end] : null;
}
async function mediaResponse(request,lookup,avatar) {
  const url = new URL(request.url);
  if (!['GET','HEAD'].includes(request.method)) return missing();
  const portrait=/^\/([0-9a-f]{64})\/avatar\/([^/]{1,768})$/.exec(url.pathname);
  if (url.host==='archive' && portrait && avatar) {
    const bytes=await avatar('wechat:'+portrait[1],decodeURIComponent(portrait[2]));
    const mime=bytes && identify(bytes,'image',false)?.mime;
    return mime ? new Response(request.method==='HEAD'?null:bytes,{headers:{'content-type':mime,'x-content-type-options':'nosniff','cache-control':'private, max-age=120'}}) : missing();
  }

  const match = /^\/([0-9a-f]{64})\/([1-9]\d{0,15})\/(preview|play|frame)$/.exec(url.pathname);
  if (url.host !== 'archive' || !match || !['GET','HEAD'].includes(request.method)) return missing();
  const [,hash,id,slot] = match;
  const rowid = Number(id);
  if (!Number.isSafeInteger(rowid)) return missing();
  const item = await lookup('wechat:'+hash,rowid);
  if (!item?.row || !item.root) return missing();
  const timingScale=Number(url.searchParams.get('timing')||1);
  if(![0.5,1,1.5,2,3].includes(timingScale))return missing();
  const diagnostics={};
  const asset=await resolveAsset(item.root,item.row,slot,{...item,diagnostics,timingScale});
  const type=messageContent(item.row).type;
  const blocked=!asset&&['image','video','voice'].includes(type)&&item.metadataBlocked&&
    ['metadata','index'].includes(diagnostics.stage);
  item.onOutcome?.(asset?'readable':blocked?item.metadataBlocked:diagnostics.reason||'resourceMissing',!!diagnostics.decrypted,asset?'response':blocked?(item.metadataBlocked==='metadataMissing'?'metadata':'index'):diagnostics.stage);
  if (!asset) return missing();
  const {handle,size,mime,xor,bytes} = asset;
  const range = request.headers.get('range');
  const bounds = byteRange(range,size);
  if (!bounds) {
    await handle?.close();
    return new Response(null,{status:416,headers:{'content-range':'bytes */'+size}});
  }
  const [start,end] = bounds;
  const headers = {'content-type':mime,'content-length':String(end-start+1),'accept-ranges':'bytes','cache-control':'no-store','x-content-type-options':'nosniff'};
  if (range) headers['content-range'] = `bytes ${start}-${end}/${size}`;
  const init = {status:range?206:200,headers};
  if (request.method==='HEAD') {
    await handle?.close();
    return new Response(null,init);
  }
  if (bytes) return new Response(bytes.subarray(start,end+1),init);
  if (xor) {
    try {
      const data = await handle.readFile();
      const section = data.subarray(start,end+1).map(byte=>byte^xor);
      return new Response(section,init);
    } finally { await handle.close(); }
  }
  return new Response(Readable.toWeb(handle.createReadStream({start,end})),init);
}
module.exports = {mediaScheme,accountFor,resolveAsset,mediaResponse};
