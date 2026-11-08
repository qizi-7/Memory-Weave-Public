const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite'),{Store}=require('../electron/store.cjs');
const {ArchiveViews}=require('../electron/archive-views.cjs'),{prepareProjection,installProjection}=require('../electron/archive-projection.cjs');
const {LatestStats}=require('../electron/latest-stats.cjs');
const pause=()=>new Promise(r=>setTimeout(r,5));
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mw-reliability-')),file=path.join(dir,'workspace.sqlite'),store=new Store(file);
 t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true})});return {file,store,db:store.db};
}
function oracle(db,a){
 const clauses=['hidden=0'],params=[];
 for(const [key,op] of [['account','='],['chat','='],['from','>='],['to','<']])if(a[key]!=null){clauses.push((['from','to'].includes(key)?'ts':key)+op+'?');params.push(a[key])}
 const from=' FROM effective WHERE '+clauses.join(' AND ');
 const summary=db.prepare('SELECT count(*) total,count(DISTINCT chat) chats,coalesce(sum(outgoing),0) sent,min(ts) first,max(ts) last'+from).get(...params);
 if(!a.account)summary.chats=db.prepare('SELECT count(*) n FROM (SELECT account,chat'+from+' GROUP BY account,chat)').get(...params).n;
 return {summary,hours:db.prepare("SELECT strftime('%H',ts,'unixepoch','localtime') hour,count(*) count"+from+' GROUP BY hour ORDER BY hour').all(...params),
 months:db.prepare("SELECT strftime('%Y-%m',ts,'unixepoch','localtime') month,count(*) count"+from+' GROUP BY month ORDER BY month DESC LIMIT 120').all(...params).reverse()};
}
function compare(db,a){const actual=new ArchiveViews(db).stats(a),expected=oracle(db,a);for(const key of ['summary','hours','months'])assert.deepEqual(JSON.parse(JSON.stringify(actual[key])),JSON.parse(JSON.stringify(expected[key])));return actual}
test('metadata migration resumes legacy archive, incremental edits/hiding/time/accounts/undo match original SQL',async t=>{
 const {store,db,file}=fixture(t);
 // An old archive has no projection triggers or derived records.
 for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'archive_fact_%'").all())db.exec('DROP TRIGGER '+name);
 db.exec("INSERT INTO accounts VALUES('a','A'),('b','B');INSERT INTO contacts VALUES('a','p','Peer'),('b','p','Peer B');"+
 "INSERT INTO messages(account,id,chat,sender,ts,text,outgoing,kind) VALUES('a','1','p','p',1700000000,'original',1,'text'),('a','2','p','p',1700000010,'image',0,'image'),('b','1','p','p',1700000020,'voice',0,'voice')");
 installProjection(db);await prepareProjection(db);
 const all=compare(db,{});assert.equal(all.summary.chats,2);assert.equal(all.summary.total,3);
 const filters=[{}, {account:'a'},{account:'b'},{account:'a',chat:'p',from:1700000000,to:1700000010}];
 const verify=()=>filters.forEach(a=>compare(db,a));verify();
 const rowid=db.prepare("SELECT rowid FROM messages WHERE account='a' AND id='2'").get().rowid;
 const edit=(hidden,ts,text)=>store.edit({account:'a',rowid,note:'',hidden,ts,text});
 edit(false,1700000010,'changed body');verify();assert.equal(db.prepare("SELECT text FROM messages WHERE rowid=?").get(rowid).text,'image');
 edit(true,1700000010,null);verify();assert.equal(compare(db,{account:'a'}).summary.total,1);
 edit(false,1700000001,null);verify();store.undo({account:'a',rowid});verify();
 db.exec('BEGIN;UPDATE messages SET outgoing=0 WHERE rowid=1;ROLLBACK');verify();
 store.importData({version:1,account:{id:'a',name:'A'},contacts:[{id:'p',name:'Renamed'}],messages:[{id:'new',chat:'p',sender:'p',timestamp:1700000002,text:'new',outgoing:false,kind:'text'}]});verify();
 assert.equal(compare(db,{account:'a'}).top[0].name,'Renamed');
 db.exec("DELETE FROM messages WHERE account='b';INSERT INTO messages(rowid,account,id,chat,sender,ts,text,outgoing,kind) VALUES(3,'b','reused','p','p',1700000003,'replacement',1,'text')");verify();
 const second=new DatabaseSync(file);t.after(()=>second.close());assert.deepEqual(new ArchiveViews(second).stats({}),new ArchiveViews(db).stats({}));
 assert.equal(db.prepare('SELECT count(*) n FROM archive_stat_results').get().n<=12,true);
});
test('projection cancellation retains atomic checkpoints; resume and reconstruction never duplicate or omit rows',async t=>{
 const {db}=fixture(t);
 db.exec("INSERT INTO accounts VALUES('a','A');WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<12001) INSERT INTO messages(account,id,chat,sender,ts,text,outgoing,kind) SELECT 'a','m'||i,'p','p',1700000000+i,'synthetic',i%2,'text' FROM n");
 db.exec('DELETE FROM archive_facts');
 let stopped=false;
 await assert.rejects(prepareProjection(db,{cancelled:()=>stopped,onBatch:()=>{stopped=true}}),/取消/);
 assert.equal(db.prepare('SELECT cursor FROM archive_fact_state').get().cursor,5000);
 assert.equal(db.prepare('SELECT count(*) n FROM archive_facts').get().n,5000);
 assert.equal(db.prepare('SELECT ready FROM archive_fact_state').get().ready,0);
 // Writes while the projection is incomplete are reflected transactionally.
 db.exec('UPDATE messages SET ts=0 WHERE rowid=6000');
 await prepareProjection(db);assert.equal(compare(db,{}).summary.total,12001);
 assert.equal(db.prepare('SELECT ts FROM archive_facts WHERE rowid=6000').get().ts,0);
 db.exec('BEGIN;DELETE FROM archive_facts;UPDATE archive_fact_state SET cursor=0,ready=0,revision=revision+1;DELETE FROM archive_stat_results;COMMIT');
 await prepareProjection(db);assert.equal(compare(db,{}).summary.total,12001);
 assert.equal(db.prepare('SELECT count(*) n FROM messages').get().n,12001);
});
test('latest statistics cancels superseded intents and explicit requests without cancelling the new request',async t=>{
 const {db,file}=fixture(t);db.exec("INSERT INTO accounts VALUES('a','A'),('b','B')");
 let release;const barrier=new Promise(r=>{release=r}),jobs=new LatestStats(file,()=>barrier);t.after(()=>jobs.close());
 const first=jobs.run('first',{account:'a'});const denied=assert.rejects(first,/取消/);
 const second=jobs.run('second',{account:'b'});assert.equal(jobs.cancel('first'),false);release();
 await denied;assert.equal((await second).summary.total,0);
 const third=jobs.run('third',{}),cancelled=assert.rejects(third,/取消/);
 assert.equal(jobs.cancel('third'),true);await cancelled;await jobs.close();
 await assert.rejects(jobs.run('closed',{}),/关闭/);
});
test('media pagination covers ancient timestamps, same-second ties, multiple accounts and conversations',async t=>{
 const {db}=fixture(t);
 db.exec("INSERT INTO accounts VALUES('a','A'),('b','B');WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<1001) INSERT INTO messages(account,id,chat,sender,ts,text,outgoing,kind) SELECT CASE WHEN i%2=0 THEN 'a' ELSE 'b' END,'m'||i,'p'||(i%17),'p',CASE WHEN i<900 THEN 1 ELSE 1700000000 END,'<msg><img /></msg>',0,CASE WHEN i%3=0 THEN 'image' WHEN i%3=1 THEN 'video' ELSE 'voice' END FROM n");
 await prepareProjection(db);
 const views=new ArchiveViews(db);
 for(const filters of [{from:0,to:2},{account:'a',from:0,to:2},{account:'b',chat:'p1',from:0,to:2},{account:'a',kind:'image'}]){
  const where=[],params=[];for(const [key,op] of [['account','='],['chat','='],['kind','='],['from','>='],['to','<']])if(filters[key]!=null){where.push((key==='from'||key==='to'?'ts':key)+op+'?');params.push(filters[key])}
  const expected=db.prepare('SELECT rowid FROM effective WHERE hidden=0 AND '+where.join(' AND ')+' ORDER BY rowid DESC').all(...params).map(r=>r.rowid);
  let before,ids=[];do{const page=views.browse({...filters,before,limit:37},'media');ids.push(...page.items.map(r=>r.rowid));before=page.next}while(before!==null);
  assert.deepEqual(ids,expected);assert.equal(new Set(ids).size,ids.length);
 }
});
test('running statistics cancellation stops reconstruction at a committed batch and resumes for latest filter',async t=>{
 const {db,file}=fixture(t);
 db.exec("INSERT INTO accounts VALUES('a','A');WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<75001) INSERT INTO messages(account,id,chat,sender,ts,text,outgoing,kind) SELECT 'a','m'||i,'p','p',1700000000+i,'synthetic',0,'text' FROM n;DELETE FROM archive_facts");
 const jobs=new LatestStats(file);t.after(()=>jobs.close());
 const obsolete=jobs.run('obsolete',{account:'a'}),denied=assert.rejects(obsolete,/取消/);
 const deadline=Date.now()+12000;
 while(db.prepare('SELECT cursor FROM archive_fact_state').get().cursor===0){if(Date.now()>deadline)throw Error('worker did not commit projection batch');await pause()}
 assert.equal(jobs.cancel('obsolete'),true);await denied;await jobs.stopping;
 const checkpoint=db.prepare('SELECT cursor,ready FROM archive_fact_state').get();
 assert.equal(checkpoint.ready,0);assert.ok(checkpoint.cursor>=5000&&checkpoint.cursor<75001);
 assert.equal(db.prepare('SELECT count(*) n FROM archive_facts').get().n,checkpoint.cursor);
 const latest=await jobs.run('latest',{account:'a',from:1700000000,to:1700000101});
 assert.equal(latest.summary.total,100);assert.equal(db.prepare('SELECT count(*) n FROM archive_facts').get().n,75001);
 assert.equal(db.prepare('SELECT count(*) n FROM messages').get().n,75001);await jobs.close();
});
test('read-only views never build or cache derived data; incomplete projection cannot masquerade as complete stats',async t=>{
 const {db,file}=fixture(t);
 assert.throws(()=>new ArchiveViews(db).stats({}),/尚未完成/);
 await prepareProjection(db);
 const ro=new DatabaseSync(file,{readOnly:true});t.after(()=>ro.close());
 const before=db.prepare('SELECT count(*) n FROM archive_stat_results').get().n;
 assert.equal(new ArchiveViews(ro,{persist:false}).stats({}).summary.total,0);
 assert.equal(db.prepare('SELECT count(*) n FROM archive_stat_results').get().n,before);
 assert.throws(()=>ro.exec('DELETE FROM archive_facts'),/readonly/);
});
test('projection migration preserves source rows, sync checkpoints, gap and local settings sentinels',async t=>{
 const {db,file}=fixture(t);
 db.exec("CREATE TABLE wechat_sync_cursor(account TEXT,cursor TEXT,done INTEGER);INSERT INTO wechat_sync_cursor VALUES('a','synthetic-cursor',0);CREATE TABLE wechat_sync_gaps(row_id INTEGER,state TEXT);INSERT INTO wechat_sync_gaps VALUES(17,'pending');CREATE TABLE settings(name TEXT,value TEXT);INSERT INTO settings VALUES('synthetic','kept')");
 const snap=()=>['wechat_sync_cursor','wechat_sync_gaps','settings'].map(t=>db.prepare('SELECT * FROM '+t).all());
 const before=snap();installProjection(db);const derived=new DatabaseSync(file);
 await prepareProjection(derived);assert.deepEqual(snap(),before);
 assert.equal(derived.prepare('PRAGMA synchronous').get().synchronous,1);
 assert.equal(db.prepare('PRAGMA synchronous').get().synchronous,2);derived.close();
});
test('source imports remain FULL and commit consistently while background metadata batches own short write locks',async t=>{
 const {db,file,store}=fixture(t);
 db.exec("INSERT INTO accounts VALUES('a','A');WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<100001) INSERT INTO messages(account,id,chat,sender,ts,text,outgoing,kind) SELECT 'a','m'||i,'p','p',1700000000+i,'synthetic',0,'text' FROM n;DELETE FROM archive_facts");
 const jobs=new LatestStats(file);t.after(()=>jobs.close());
 const result=jobs.run('building',{account:'a'}),deadline=Date.now()+12000;
 while(db.prepare('SELECT cursor FROM archive_fact_state').get().cursor===0){if(Date.now()>deadline)throw Error('no build progress');await pause()}
 store.importData({version:1,account:{id:'a',name:'A'},contacts:[{id:'p',name:'P'}],messages:Array.from({length:100},(_,i)=>({id:'new'+i,chat:'p',sender:'p',timestamp:1700000000+i,text:'synthetic new',outgoing:true,kind:'text'}))});
 assert.equal(db.prepare('PRAGMA synchronous').get().synchronous,2);
 assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout,3000);
 await result;assert.equal((await jobs.run('refreshed',{account:'a'})).summary.total,100101);
 assert.equal(db.prepare('SELECT count(*) n FROM messages').get().n,100101);await jobs.close();
});
