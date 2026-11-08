const {createHash}=require('node:crypto');

const sourceId=source=>createHash('sha256').update(source).digest('hex').slice(0,12);

function openRetryQueue(db,account){
 db.exec(`CREATE TABLE IF NOT EXISTS wechat_sync_retry(
   account TEXT, source TEXT, phase TEXT, checkpoint TEXT, row_id TEXT, kind TEXT,
   updated_at INTEGER, resolved_at INTEGER, PRIMARY KEY(account,source,phase)
 )`);
 const pending=db.prepare(`SELECT source,phase,checkpoint,row_id,kind FROM wechat_sync_retry
  WHERE account=? AND resolved_at IS NULL ORDER BY updated_at,source,phase`);
 const save=db.prepare(`INSERT INTO wechat_sync_retry VALUES(?,?,?,?,?,?,?,NULL)
  ON CONFLICT(account,source,phase) DO UPDATE SET checkpoint=excluded.checkpoint,
  row_id=excluded.row_id,kind=excluded.kind,updated_at=excluded.updated_at,resolved_at=NULL`);
 const resolve=db.prepare('UPDATE wechat_sync_retry SET resolved_at=? WHERE account=? AND source=? AND phase=? AND resolved_at IS NULL');
 return {
  pending:()=>pending.all(account),
  defer(context,error){save.run(account,context.source,context.phase,context.checkpoint??null,error.rowId??null,error.code||'QUERY_FAILED',Date.now())},
  resolve(source,phase){resolve.run(Date.now(),account,source,phase)},
  seedLegacy(){
   const hasWindow=db.prepare("SELECT 1 FROM sqlite_master WHERE name='wechat_sync_window'").get();
   if(!hasWindow)return;
   const window=db.prepare('SELECT cutoff FROM wechat_sync_window WHERE account=?').get(account);
   const haveCursors=db.prepare("SELECT 1 FROM sqlite_master WHERE name='wechat_sync_cursor'").get();
   if(!window||!haveCursors)return;
   // Old builds stopped the whole run at the first error. Recover that table's unfinished phase.
   db.prepare(`INSERT OR IGNORE INTO wechat_sync_retry
    SELECT e.account,e.source,e.phase,c.cursor,NULL,e.kind,e.occurred_at,NULL
    FROM wechat_sync_errors e LEFT JOIN wechat_sync_cursor c
      ON c.account=e.account AND c.source=e.source AND c.phase=e.phase
    WHERE e.account=? AND (c.done=0 OR c.source IS NULL) AND e.phase IN ('preview','recent','history') AND e.occurred_at>=? AND e.kind='QUERY_FAILED'
    ORDER BY e.occurred_at DESC,c.scanned DESC LIMIT 1`).run(account,(window.cutoff+30*86400)*1000);
  }
 };
}
const retryableRead=new Set(['PAGE_BYTES','BRIDGE_JSON','BRIDGE_UTF8','NATIVE_READ','ROW_OVERSIZE','ROW_BYTES','ROW_CONTENT','NATIVE_TIMEOUT']);
const pageLimits=initial=>[initial,...[500,250,100,50,25,10,5,1].filter(size=>size<initial)];
function growBatch(state,limit,maximum){
 if(limit<state.size)return {size:limit,streak:0};
 const streak=state.streak+1;
 return streak>=3?{size:Math.min(maximum,Math.max(limit+1,limit*2)),streak:0}:{size:limit,streak};
}
module.exports={sourceId,openRetryQueue,retryableRead,pageLimits,growBatch};
