const fs=require('node:fs');
const path=require('node:path');
const {createDecipheriv}=require('node:crypto');

const maxBytes=1024*1024;
const decode=new TextDecoder('utf-8',{fatal:true});
const validId=/^[A-Za-z0-9_-]{1,200}$/u;

// Length-prefixed records: key byte array, then value byte array.
// A stored string has an additional length prefix inside its value.
function cursor(buffer){
 let offset=0;
 function number(){
  let result=0;
  for(let shift=0;shift<=28;shift+=7){
   if(offset>=buffer.length)throw Error('short length');
   const byte=buffer[offset++];
   result+=(byte&127)*2**shift;
   if(!(byte&128)&&result<=0xffffffff)return result;
  }
  throw Error('invalid length');
 }
 return {number,remaining:()=>buffer.length-offset,bytes(){
  const size=number();
  if(size>buffer.length-offset)throw Error('short value');
  const start=offset;offset+=size;return buffer.subarray(start,offset);
 }};
}

function readRecords(data,hasMapPrefix){
 const records=cursor(data),profile=new Map();
 if(hasMapPrefix)records.number();
 while(records.remaining()){
  const keyBytes=records.bytes();
  if(!keyBytes.length)throw Error('empty profile key');
  const key=decode.decode(keyBytes);
  if(/[\u0000-\u001f\u007f]/u.test(key))throw Error('invalid profile key');
  const raw=records.bytes();
  if(!['mmkv_key_user_name','mmkv_key_nick_name','mmkv_key_nickname'].includes(key))continue;
  if(!raw.length){profile.delete(key);continue;}
  const nested=cursor(raw),value=decode.decode(nested.bytes());
  if(nested.remaining()||/[\u0000-\u001f\u007f]/u.test(value))throw Error('invalid profile string');
  profile.set(key,value);
 }
 const wxid=profile.get('mmkv_key_user_name');
 const nickname=(profile.get('mmkv_key_nick_name')||profile.get('mmkv_key_nickname')||'').trim();
 return wxid&&validId.test(wxid)?{wxid,nickname:nickname.length<=200?nickname:''}:null;
}

function readLocalAccountIdentity(parent){
 const file=path.join(parent,'all_users','config','global_config');
 let fd;
 try{
  if(fs.realpathSync(file)!==file)return null;
  fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  const stat=fs.fstatSync(fd);
  if(!stat.isFile()||stat.size<=4||stat.size>maxBytes)return null;
  const buffer=Buffer.alloc(stat.size);
  let read=0;
  while(read<buffer.length){
   const n=fs.readSync(fd,buffer,read,buffer.length-read,read);
   if(!n)return null;
   read+=n;
  }
  if(fs.fstatSync(fd).size!==stat.size)return null;
  const size=buffer.readUInt32LE(0)||buffer.length-4;
  if(size>buffer.length-4)return null;
  // This is the fixed format parameter for legacy local profile files, not a user credential.
  const decipher=createDecipheriv('aes-128-cfb',Buffer.from('xwechat_crypt_key').subarray(0,16),Buffer.alloc(16));
  const clear=Buffer.concat([decipher.update(buffer.subarray(4,4+size)),decipher.final()]);
  const matches=[false,true].flatMap(prefix=>{
   try{const record=readRecords(clear,prefix);return record?[record]:[];}catch{return [];}
  });
  return matches.length&&matches.every(x=>x.wxid===matches[0].wxid&&x.nickname===matches[0].nickname)?matches[0]:null;
 }catch{return null;}finally{if(fd!==undefined)fs.closeSync(fd);}
}

function accountDirectoryBelongsToIdentity(directory,wxid){
 return typeof directory==='string'&&typeof wxid==='string'&&validId.test(wxid)&&
  (directory===wxid||(directory.startsWith(wxid+'_')&&/^[a-z0-9]{4}$/i.test(directory.slice(wxid.length+1))));
}
module.exports={readLocalAccountIdentity,accountDirectoryBelongsToIdentity};
