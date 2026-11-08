const fs=require('node:fs');

function parseEntry(value){
 const raw=typeof value==='string'?value:value?.enc_key??value?.key_hex;
 const match=typeof raw==='string'&&raw.trim().match(/^(?:x'([a-f0-9]{64}(?:[a-f0-9]{32})?)'|([a-f0-9]{64}(?:[a-f0-9]{32})?))$/i);
 if(!match)return null;
 const hex=(match[1]||match[2]).toLowerCase();
 const salt=hex.slice(64)||value?.salt_hex||value?.salt||'';
 if(salt&&!/^[a-f0-9]{32}$/i.test(salt))return null;
 return {key:hex.slice(0,64),salt:salt.toLowerCase()};
}

function keysForDatabases(input,allowDecrypted){
 if(typeof input!=='string'||input.length>262144)throw Error('密钥输入格式或大小无效。');
 if(!input.trim()&&allowDecrypted===true)return ()=> '';
 const single=parseEntry(input);
 let entries;
 if(!single){
  try{entries=JSON.parse(input);}catch{}
  if(!entries||typeof entries!=='object'||Array.isArray(entries))throw Error('请输入十六进制数据库密钥或逐库密钥 JSON。');
  entries=new Map(Object.entries(entries).map(([name,value])=>[name.replaceAll('\\','/'),value]));
 }
 const saltCache=entries&&[...entries.keys()].every(name=>/^[a-f0-9]{16}:[a-f0-9]{32}$/i.test(name));
 if(entries&&[...entries.keys()].some(name=>/^[a-f0-9]{16}:[a-f0-9]{32}$/i.test(name))&&!saltCache)throw Error('派生缓存与逐库路径格式不能混用。');
 const select=(relative,file)=>{
  if(saltCache){
   const header=Buffer.alloc(16),fd=fs.openSync(file,'r');try{if(fs.readSync(fd,header,0,16,0)!==16)throw Error('数据库文件头不完整。')}finally{fs.closeSync(fd)}
   const values=[...entries].filter(([name])=>name.split(':')[1].toLowerCase()===header.toString('hex')).map(([,value])=>parseEntry(value));
   if(!values.length||values.some(value=>!value))throw Error('派生密钥缓存没有匹配当前数据库 Salt 的有效条目。请提供当前 Raw Key 或完整逐库密钥。');
   const keys=new Set(values.map(value=>value.key));if(keys.size!==1)throw Error('同一 Salt 对应多个 Raw Key 指纹，无法安全选择派生密钥；请提供明确的 Raw Key。');
   return values[0].key;
  }

  const entry=single||parseEntry(entries.get(relative));
  if(!entry)throw Error('逐库密钥缺失或格式无效：'+relative);
  if(entry.salt){
   const header=Buffer.alloc(16);
   const fd=fs.openSync(file,'r');
   try{if(fs.readSync(fd,header,0,16,0)!==16||header.toString('hex')!==entry.salt)throw Error('密钥附带的 salt 与数据库不匹配：'+relative);}
   finally{fs.closeSync(fd);}
  }
  return entry.key;
 };
 select.derived=!!saltCache;return select;
}
module.exports={keysForDatabases};
