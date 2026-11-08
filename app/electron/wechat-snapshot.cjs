const fs=require('node:fs');const fsp=fs.promises;const path=require('node:path');const os=require('node:os');const crypto=require('node:crypto');
async function hash(file){
 const handle=await fsp.open(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 const digest=crypto.createHash('sha256');try{for await(const b of handle.createReadStream({autoClose:false}))digest.update(b);return digest.digest('hex');}finally{await handle.close();}
}
async function exists(file){try{await fsp.lstat(file);return true}catch(e){if(e.code==='ENOENT')return false;throw e}}
async function validateWal(file){
 const h=await fsp.open(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const {size}=await h.stat();if(!size)return;const header=Buffer.alloc(32);const {bytesRead}=await h.read(header,0,32,0);const magic=header.readUInt32BE(0),page=header.readUInt32BE(8);
 if(bytesRead!==32||![0x377f0682,0x377f0683].includes(magic)||header.readUInt32BE(4)!==3007000||page<512||page>65536||(page&(page-1))!==0)throw Error('当前微信日志头部无法识别，请正常退出微信后重试或提供完整备份。');
 }finally{await h.close();}
}
// Copies source bytes only. SQLite is opened exclusively on the private copy.
async function createSnapshot(sourceRoot,relatives){
 const canonical=await fsp.realpath(sourceRoot),temp=await fsp.mkdtemp(path.join(os.tmpdir(),'weave-wechat-copy-'));await fsp.chmod(temp,0o700);
 const sources=[],walPresence=new Map(),identities={};
 try{
  for(const relative of relatives){
   if(path.isAbsolute(relative)||relative.split(/[\\/]/).includes('..'))throw Error('无效的数据库相对路径');
   const source=await fsp.realpath(path.join(canonical,relative));if(!source.startsWith(canonical+path.sep))throw Error('数据库链接超出授权目录');
   identities[relative]=require('./wechat-integrity.cjs').fileIdentity(source);sources.push({source,relative});const wal=source+'-wal';const present=await exists(wal);walPresence.set(source,present);
   if(present){const realWal=await fsp.realpath(wal);if(realWal!==wal)throw Error('不支持链接到其他位置的 WAL 文件');await validateWal(wal);sources.push({source:wal,relative:relative+'-wal'});}
  }
  const before=new Map();for(const s of sources)before.set(s.source,await hash(s.source));
  for(const s of sources){const target=path.join(temp,s.relative);await fsp.mkdir(path.dirname(target),{recursive:true,mode:0o700});await fsp.copyFile(s.source,target,fs.constants.COPYFILE_FICLONE);await fsp.chmod(target,0o600);if(await hash(target)!==before.get(s.source))throw Error('复制期间微信数据发生变化，请正常退出微信后重试。');}
  for(const s of sources)if(await hash(s.source)!==before.get(s.source))throw Error('复制期间微信数据发生变化，请正常退出微信后重试。');
  for(const [source,present] of walPresence)if(await exists(source+'-wal')!==present)throw Error('复制期间微信日志发生变化，请正常退出微信后重试。');
  for(const {source,relative} of sources)if(identities[relative]&&require('./wechat-integrity.cjs').fileIdentity(source)!==identities[relative])throw Error('复制期间微信数据发生变化，请重试。');
  return {root:temp,identities,fingerprint:crypto.createHash('sha256').update(JSON.stringify([...before.values()])).digest('hex'),walFiles:sources.filter(s=>s.relative.endsWith('-wal')).length,cleanup:()=>fsp.rm(temp,{recursive:true,force:true})};
 }catch(e){await fsp.rm(temp,{recursive:true,force:true});if(e.code==='EACCES'||e.code==='EPERM')throw Error('无法读取微信数据，请重新选择账号目录授予本机访问权限。');throw e;}
}
module.exports={createSnapshot,hash};
