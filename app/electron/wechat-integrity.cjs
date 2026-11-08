const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {sourceId}=require('./wechat-sync-retry.cjs');
const week=7*86400000;
function fileIdentity(file){
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{
  const s=fs.fstatSync(fd,{bigint:true}),header=Buffer.alloc(16);
  if(!s.isFile())throw Error('微信数据库不是普通文件。');
  const bytes=fs.readSync(fd,header,0,16,0);
  return crypto.createHash('sha256').update(`${s.dev}:${s.ino}:${s.birthtimeNs}:`).update(header.subarray(0,bytes)).digest('hex');
 }finally{fs.closeSync(fd)}
}
function openIntegrity(db,account){
 db.exec(`CREATE TABLE IF NOT EXISTS wechat_source_lineage(account TEXT,source TEXT,identity TEXT NOT NULL,PRIMARY KEY(account,source));
 CREATE TABLE IF NOT EXISTS wechat_source_receipt(account TEXT PRIMARY KEY,grant_id TEXT,stamp TEXT,audit_due INTEGER NOT NULL,verified_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS wechat_source_stamp(account TEXT PRIMARY KEY,manifest TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS wechat_source_reconciliation(account TEXT,source_id TEXT,verified_at INTEGER,rows_verified INTEGER,PRIMARY KEY(account,source_id));
 CREATE TABLE IF NOT EXISTS wechat_source_discrepancy(account TEXT,source_id TEXT,kind TEXT,first_seen INTEGER,last_seen INTEGER,affected INTEGER,PRIMARY KEY(account,source_id,kind));`);
 const lineage=db.prepare('SELECT identity FROM wechat_source_lineage WHERE account=? AND source=?');
 const remember=db.prepare('INSERT OR IGNORE INTO wechat_source_lineage VALUES(?,?,?)');
 const note=db.prepare(`INSERT INTO wechat_source_discrepancy VALUES(?,?,?,?,?,?) ON CONFLICT(account,source_id,kind) DO UPDATE SET last_seen=excluded.last_seen,affected=excluded.affected`);
 return {
  check(source,value){const old=lineage.get(account,source);return !old||old.identity===value},
  known(source,value){return lineage.get(account,source)?.identity===value},
  reconcile(source,matched){db.prepare('INSERT OR REPLACE INTO wechat_source_reconciliation VALUES(?,?,?,?)').run(account,sourceId(source),Date.now(),matched)},
  tracked:()=>db.prepare('SELECT source FROM wechat_source_lineage WHERE account=?').all(account).map(x=>x.source),
  remember:(source,value)=>remember.run(account,source,value),
  note(source,kind,count=1){const now=Date.now();note.run(account,sourceId(source),kind,now,now,count)},
  count:()=>db.prepare(`SELECT count(*) n FROM wechat_source_discrepancy d LEFT JOIN wechat_source_reconciliation r USING(account,source_id) WHERE d.account=? AND (d.kind<>'ANCHOR_CHANGED' OR r.verified_at IS NULL OR r.verified_at<d.last_seen)`).get(account).n,
  receipt:()=>db.prepare('SELECT r.*,s.manifest FROM wechat_source_receipt r LEFT JOIN wechat_source_stamp s USING(account) WHERE r.account=?').get(account),
  commit(grant,stamp,due,verifiedAt,files){
   db.exec('BEGIN IMMEDIATE');
   try{
    db.prepare('INSERT OR REPLACE INTO wechat_source_receipt VALUES(?,?,?,?,?)').run(account,grant,stamp,due,verifiedAt);
    db.prepare('INSERT OR REPLACE INTO wechat_source_stamp VALUES(?,?)').run(account,JSON.stringify(files));
    db.exec('COMMIT');
   }catch(error){db.exec('ROLLBACK');throw error;}
  },
 };
}
module.exports={fileIdentity,openIntegrity,week};
