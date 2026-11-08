// Rebuildable metadata only. No bodies, source credentials, media or sync checkpoints.
function installProjection(db){
 db.exec('BEGIN IMMEDIATE');
 try{db.exec(`CREATE TABLE IF NOT EXISTS archive_fact_state(id INTEGER PRIMARY KEY CHECK(id=1),cursor INTEGER NOT NULL DEFAULT 0,ready INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0);
 INSERT OR IGNORE INTO archive_fact_state(id) VALUES(1);
 CREATE TABLE IF NOT EXISTS archive_facts(rowid INTEGER PRIMARY KEY,account TEXT,chat TEXT,ts INTEGER,outgoing INTEGER,hidden INTEGER,kind TEXT);
 CREATE INDEX IF NOT EXISTS archive_facts_scope ON archive_facts(account,hidden,ts,chat,outgoing,kind);
 CREATE INDEX IF NOT EXISTS archive_facts_range ON archive_facts(hidden,ts,account,chat,kind);
 CREATE TABLE IF NOT EXISTS archive_stat_results(key TEXT PRIMARY KEY,revision INTEGER NOT NULL,value TEXT NOT NULL);`);
 const fact=(message)=>`INSERT INTO archive_facts SELECT m.rowid,m.account,m.chat,COALESCE(e.ts,m.ts),m.outgoing,COALESCE(e.hidden,0),m.kind FROM messages m LEFT JOIN edits e ON e.message=m.rowid WHERE m.rowid=${message} ON CONFLICT(rowid) DO UPDATE SET account=excluded.account,chat=excluded.chat,ts=excluded.ts,outgoing=excluded.outgoing,hidden=excluded.hidden,kind=excluded.kind;`;
 const bump='UPDATE archive_fact_state SET revision=revision+1 WHERE id=1;';
 for(const [name,event,body] of [
  ['message_insert','AFTER INSERT ON messages',fact('new.rowid')],
  ['message_update','AFTER UPDATE ON messages',fact('new.rowid')],
  ['message_delete','AFTER DELETE ON messages','DELETE FROM archive_facts WHERE rowid=old.rowid;'],
  ['edit_insert','AFTER INSERT ON edits',fact('new.message')],
  ['edit_update','AFTER UPDATE ON edits',fact('new.message')],
  ['edit_delete','AFTER DELETE ON edits',fact('old.message')],
  ['contact_insert','AFTER INSERT ON contacts',''],
  ['contact_update','AFTER UPDATE ON contacts',''],
  ['contact_delete','AFTER DELETE ON contacts','']
 ])db.exec(`CREATE TRIGGER IF NOT EXISTS archive_fact_${name} ${event} BEGIN ${body}${bump} END`);
 db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error}
}
const yieldTurn=()=>new Promise(resolve=>setImmediate(resolve));
async function prepareProjection(db,{cancelled=()=>false,onBatch=()=>{}}={}){
 // This connection writes only rebuildable metadata. NORMAL is connection-local;
 // source imports/edits keep their own FULL durability. A lost derived commit is
 // atomic with its cursor and may be rebuilt after a power failure.
 db.exec('PRAGMA cache_size=-65536; PRAGMA temp_store=FILE; PRAGMA synchronous=NORMAL');
 const abort=()=>{if(cancelled())throw Error('统计请求已取消')};
 abort();
 while(!db.prepare('SELECT ready FROM archive_fact_state WHERE id=1').get().ready){
  abort();
  db.exec('BEGIN IMMEDIATE');
  try{
   const {cursor}=db.prepare('SELECT cursor FROM archive_fact_state WHERE id=1').get();
   const end=db.prepare('SELECT rowid FROM messages WHERE rowid>? ORDER BY rowid LIMIT 1 OFFSET 4999').get(cursor)?.rowid
    ??db.prepare('SELECT max(rowid) rowid FROM messages WHERE rowid>?').get(cursor)?.rowid;
   if(end===null||end===undefined)db.prepare('UPDATE archive_fact_state SET ready=1 WHERE id=1').run();
   else{
    db.prepare(`INSERT OR REPLACE INTO archive_facts SELECT m.rowid,m.account,m.chat,COALESCE(e.ts,m.ts),m.outgoing,COALESCE(e.hidden,0),m.kind FROM messages m LEFT JOIN edits e ON e.message=m.rowid WHERE m.rowid>? AND m.rowid<=?`).run(cursor,end);
    db.prepare('UPDATE archive_fact_state SET cursor=? WHERE id=1').run(end);
   }
   db.exec('COMMIT');
   onBatch();
  }catch(error){db.exec('ROLLBACK');throw error}
  await yieldTurn();
 }
 abort();
}
function projectionReady(db){return !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='archive_fact_state'").get()&&!!db.prepare('SELECT ready FROM archive_fact_state WHERE id=1').get().ready}
module.exports={installProjection,prepareProjection,projectionReady};
