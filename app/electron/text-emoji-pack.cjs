const fs=require('node:fs/promises'),path=require('node:path'),{createHash}=require('node:crypto');
const vocabulary=require('./text-emoji-names.json');
const names=new Set(vocabulary.names.map(name=>'['+name+']'));
function validatePack(pack,decode){
 if(pack?.version!==1||typeof pack.source!=='string'||!pack.source.trim()||pack.source.length>200||typeof pack.license!=='string'||!pack.license.trim()||pack.license.length>200||!Array.isArray(pack.assets)||pack.assets.length>109)throw Error('资源包格式无效。');
 const result={};let total=0;
 for(const item of pack.assets){
  if(!names.has(item?.name)||Object.hasOwn(result,item.name)||!['image/png','image/gif','image/webp'].includes(item.mime)||typeof item.base64!=='string'||item.base64.length>700000||!/^[A-Za-z0-9+/]*={0,2}$/.test(item.base64))throw Error('资源名称或图片格式无效。');
  const bytes=Buffer.from(item.base64,'base64');total+=bytes.length;
  const magic=item.mime==='image/png'?bytes.subarray(0,8).toString('hex')==='89504e470d0a1a0a':item.mime==='image/gif'?/^GIF8[79]a$/.test(bytes.subarray(0,6).toString()):bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP';
  if(!magic||!bytes.length||bytes.length>524288||total>8388608||createHash('sha256').update(bytes).digest('hex')!==item.sha256)throw Error('资源校验失败。');
  const size=decode(bytes);if(!size||size.width<1||size.height<1||size.width>512||size.height>512)throw Error('图片无法解码或尺寸超限。');
  result[item.name]=`data:${item.mime};base64,${bytes.toString('base64')}`;
 }
 return result;
}
class EmojiPack {
 constructor(directory,decode){this.file=path.join(directory,'authorized-text-emoji.json');this.decode=decode;this.assets=null;this.pending=null}
 async get(){if(this.assets)return this.assets;return this.pending??=(async()=>{try{const stat=await fs.stat(this.file);if(stat.size>12000000)throw Error();return this.assets=validatePack(JSON.parse(await fs.readFile(this.file,'utf8')),this.decode)}catch{return this.assets={}}finally{this.pending=null}})()}
 async import(file,confirmed){
  if(confirmed!==true)throw Error('请确认资源使用授权。');
  const handle=await fs.open(file,require('node:fs').constants.O_RDONLY|require('node:fs').constants.O_NOFOLLOW);
  let pack;try{const stat=await handle.stat();if(!stat.isFile()||stat.size>12000000)throw Error('资源包超限。');pack=JSON.parse(await handle.readFile('utf8'))}finally{await handle.close()}
  const assets=validatePack(pack,this.decode),temporary=this.file+'.'+require('node:crypto').randomUUID()+'.tmp';
  await fs.writeFile(temporary,JSON.stringify(pack),{mode:0o600,flag:'wx'});await fs.rename(temporary,this.file);this.assets=assets;return assets;
 }
}
module.exports={EmojiPack,validatePack};
