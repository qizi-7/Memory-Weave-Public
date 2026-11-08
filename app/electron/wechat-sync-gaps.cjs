// Row-level failures are durable evidence, never synthetic messages or completed history.
function openGaps(db,account){
 db.exec(`CREATE TABLE IF NOT EXISTS wechat_sync_gaps(
  account TEXT NOT NULL,source TEXT NOT NULL,phase TEXT NOT NULL,fingerprint TEXT NOT NULL,row_id TEXT NOT NULL,
  identity_key TEXT NOT NULL,kind TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL,resolved_at INTEGER,
  PRIMARY KEY(account,source,phase,fingerprint,row_id))`);
 if(!db.prepare('PRAGMA table_info(wechat_sync_gaps)').all().some(c=>c.name==='state'))db.exec("ALTER TABLE wechat_sync_gaps ADD COLUMN state TEXT NOT NULL DEFAULT 'pending'");
 const list=db.prepare('SELECT * FROM wechat_sync_gaps WHERE account=? AND source=? AND phase=? AND resolved_at IS NULL ORDER BY fingerprint,row_id');
 const save=db.prepare(`INSERT INTO wechat_sync_gaps(account,source,phase,fingerprint,row_id,identity_key,kind,attempts,updated_at,resolved_at) VALUES(?,?,?,?,?,?,?,1,?,NULL)
  ON CONFLICT(account,source,phase,fingerprint,row_id) DO UPDATE SET kind=excluded.kind,attempts=attempts+1,updated_at=excluded.updated_at,resolved_at=NULL,state='pending'`);
 const resolve=db.prepare("UPDATE wechat_sync_gaps SET resolved_at=?,state='resolved' WHERE account=? AND source=? AND phase=? AND row_id=? AND identity_key=? AND resolved_at IS NULL");
 return {
  unavailable(gap,fingerprint){db.prepare('UPDATE wechat_sync_gaps SET state=?,updated_at=? WHERE account=? AND source=? AND phase=? AND fingerprint=? AND row_id=? AND resolved_at IS NULL').run(gap.fingerprint===fingerprint?'row_missing':'source_changed',Date.now(),account,gap.source,gap.phase,gap.fingerprint,gap.row_id)},
  list:(source,phase)=>list.all(account,source,phase),
  record(source,phase,fingerprint,row,kind){save.run(account,source,phase,fingerprint,String(row.__rowid),identity(row),kind,Date.now())},
  resolve(source,phase,row){resolve.run(Date.now(),account,source,phase,String(row.__rowid),identity(row))},
 };
}
const identity=row=>JSON.stringify([String(row.__time),String(row.local_id??row.mesLocalID??row.__rowid)]);
module.exports={openGaps,identity};
