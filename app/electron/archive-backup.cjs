const fs=require('node:fs/promises'),sync=require('node:fs'),path=require('node:path');
const {DatabaseSync,backup}=require('node:sqlite'),{createHash}=require('node:crypto');
const {spawnSync}=require('node:child_process');
const tables=['accounts','contacts','session_catalog','messages','edits','revisions','local_favorites','wechat_sources','wechat_sync_window','wechat_sync_cursor','wechat_incremental_cursor','wechat_sync_retry','wechat_sync_errors','wechat_sync_gaps','wechat_source_lineage','wechat_source_receipt','wechat_source_discrepancy','wechat_source_stamp','wechat_source_reconciliation','knowledge_chunks','knowledge_manifests'];
function readonly(file){const db=new DatabaseSync(file,{readOnly:true});db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000');return db}
function summaries(db){
 const existing=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name)),result={};
 for(const table of tables){if(!existing.has(table)){result[table]={present:false,count:0};continue}
  const statement=db.prepare(`SELECT rowid AS __backup_rowid__,* FROM "${table}" ORDER BY rowid`);statement.setReadBigInts(true);
  const hash=createHash('sha256');let count=0;
  for(const row of statement.iterate()){const bytes=Buffer.from(JSON.stringify(row,(_k,value)=>typeof value==='bigint'?{$integer:String(value)}:ArrayBuffer.isView(value)?{$bytes:Buffer.from(value.buffer,value.byteOffset,value.byteLength).toString('hex')}:value));const length=Buffer.alloc(8);length.writeBigUInt64BE(BigInt(bytes.length));hash.update(length).update(bytes);count++}
  result[table]={present:true,count,digest:hash.digest('hex')};
 }
 return result;
}
async function digest(file){const hash=createHash('sha256');for await(const chunk of sync.createReadStream(file))hash.update(chunk);return hash.digest('hex')}
async function copyClone(source,destination){
 // macOS cp -c uses clonefile, with independent inodes and copy-on-write contents.
 // Other platforms use a real copy. Never use hard links for recoverable archives.
 if(process.platform==='darwin'){const r=spawnSync('/bin/cp',['-c',source,destination],{stdio:'ignore'});if(r.status!==0)throw Error('APFS 克隆失败，未自动退化成超出空间预算的复制。')}
 else await fs.copyFile(source,destination,sync.constants.COPYFILE_EXCL);
 const [a,b]=await Promise.all([fs.stat(source),fs.stat(destination)]);if(a.dev===b.dev&&a.ino===b.ino)throw Error('恢复副本不得使用硬链接。');
}
async function inventory(root){const files=[];async function walk(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true})){const file=path.join(dir,entry.name),relative=path.relative(root,file),stat=await fs.lstat(file);if(stat.isSymbolicLink())throw Error('备份清单不接受符号链接。');if(stat.isDirectory())await walk(file);else if(stat.isFile())files.push({path:relative,bytes:stat.size,sha256:await digest(file)});else throw Error('备份含非普通文件。')}}await walk(root);return files.sort((a,b)=>a.path.localeCompare(b.path))}
async function freezeArchive({source,destination,restore,reserveBytes=3*1024**3,onStage=()=>{}}){
 source=await fs.realpath(source);const stat=await fs.stat(source),parent=await fs.realpath(path.dirname(destination));
 if(!stat.isFile()||stat.nlink!==1||await fs.realpath(path.dirname(restore))===path.dirname(source)||parent===path.dirname(source))throw Error('必须使用独立备份及恢复目录。');
 if(sync.existsSync(destination)||sync.existsSync(restore))throw Error('拒绝覆盖既有备份或恢复库。');
 const space=await fs.statfs(parent);if(space.bavail*space.bsize<stat.size+reserveBytes)throw Error('空间不足，未启动备份。');
 const db=readonly(source);let restored,copy;const started=Date.now();
 try{
  db.exec('BEGIN');onStage('online-backup');const pages=await backup(db,destination,{rate:512});await fs.chmod(destination,0o600);
  onStage('source-identity');const original=summaries(db);db.exec('ROLLBACK');
  copy=readonly(destination);onStage('backup-integrity');const integrity=copy.prepare('PRAGMA integrity_check').all();if(integrity.length!==1||Object.values(integrity[0])[0]!=='ok')throw Error('备份完整性校验失败。');
  onStage('restore-clone');await copyClone(destination,restore);await fs.chmod(restore,0o600);restored=readonly(restore);
  onStage('restore-integrity');const checked=restored.prepare('PRAGMA integrity_check').all();if(checked.length!==1||Object.values(checked[0])[0]!=='ok')throw Error('恢复完整性校验失败。');
  onStage('restore-identity');const recovered=summaries(restored);if(JSON.stringify(original)!==JSON.stringify(recovered))throw Error('源端与恢复库身份摘要不一致。');
  onStage('file-digests');const [backupHash,restoreHash]=await Promise.all([digest(destination),digest(restore)]);if(backupHash!==restoreHash)throw Error('恢复文件摘要不一致。');
  return {format:1,pages,elapsedMs:Date.now()-started,integrity:'ok',restoreIntegrity:'ok',stableIdentitiesEqual:true,backupHash,restoreHash,tables:original};
 }finally{restored?.close();copy?.close();db.close()}
}
module.exports={freezeArchive,summaries,readonly,digest,copyClone,inventory};
