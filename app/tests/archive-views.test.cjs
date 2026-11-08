const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Worker}=require('node:worker_threads');
const {Store}=require('../electron/store.cjs');
const {saveFavorite,initial}=require('../electron/archive-views.cjs');
const {accountFor,mediaResponse}=require('../electron/message-media.cjs');
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mw-archive-test-')),file=path.join(dir,'workspace.sqlite');
 const store=new Store(file);
 let worker;
 t.after(async()=>{await worker?.terminate();store.close();fs.rmSync(dir,{recursive:true,force:true})});
 for(const account of ['a','b'])store.importData({version:1,account:{id:account,name:'synthetic'},contacts:[{id:'p',name:'李同学'},{id:'no-chat',name:'Alice'},{id:'q',name:'张同学'}],
  messages:[{id:'1',chat:'p',sender:'p',timestamp:1700000000,text:'first synthetic',kind:'text',outgoing:true},{id:'2',chat:'p',sender:'p',timestamp:1700000001,text:'<msg><img /></msg>',kind:'image',outgoing:false},{id:'3',chat:'q',sender:'q',timestamp:1700000002,text:'synthetic voice',kind:'voice',outgoing:false}]});
 store.registerSessions('a',['catalog-only']);
 worker=new Worker(path.resolve(__dirname,'../electron/archive-view-worker.cjs'),{workerData:{database:file,derivedWrites:true}});
 let id=0;
 const request=(method,args)=>new Promise((resolve,reject)=>{
  const current=++id;const onMessage=m=>{if(m.id!==current)return;worker.off('message',onMessage);worker.off('error',onError);m.error?reject(Error(m.error)):resolve(m.value)};
  const onError=e=>{worker.off('message',onMessage);reject(e)};
  worker.on('message',onMessage);worker.once('error',onError);worker.postMessage({id:current,method,args});
 });
 return {store,request,dir,file};
}
test('directory worker returns exact totals, no-chat contacts, initials, latest and paginated results',async t=>{
 const {request}=await fixture(t),args={account:'a',limit:1};
 const page=await request('directory',args);
 assert.equal(page.total,3);assert.equal(page.withChats,2);assert.equal(page.items.length,1);
 assert.equal(page.items[0].name,'Alice');assert.equal(page.items[0].latest,null);
 const next=await request('directory',{...args,offset:1,withChats:true});
 assert.equal(next.matched,2);assert.equal(next.items[0].group,'Z');
 assert.equal(initial('李同学'),'L');assert.equal(initial('🙂'),'#');
 assert.equal((await request('directory',{...args,query:'李'})).items[0].latest,1700000001);
 await assert.rejects(request('directory',{...args,limit:101}),/分页/);
});
test('favorites use stable account/message identity and only mutate workspace on explicit operation',async t=>{
 const {store,request}=await fixture(t),db=store.db;
 const one=db.prepare("SELECT rowid FROM messages WHERE account='a' AND id='2'").get().rowid;
 assert.equal((await request('favorites',{account:'a'})).items.length,0);
 assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='local_favorites'").get().n,0);
 assert.throws(()=>saveFavorite(db,{account:'b',rowid:one,saved:true}),/原消息/);
 saveFavorite(db,{account:'a',rowid:one,saved:true,note:'synthetic memo'});
 const item=(await request('favorites',{account:'a',chat:'p',query:'memo'})).items[0];
 assert.equal(item.rowid,one);assert.equal(item.note,'synthetic memo');assert.doesNotMatch(item.preview,/<img/);
 saveFavorite(db,{account:'a',rowid:one,saved:true});
 assert.equal((await request('favorites',{account:'a'})).items[0].note,'synthetic memo');
 assert.equal((await request('favorites',{account:'b'})).items.length,0);
 assert.equal(store.locate({account:'a',rowid:one}).rowid,one);
 saveFavorite(db,{account:'a',rowid:one,saved:false});assert.equal((await request('favorites',{account:'a'})).items.length,0);
 assert.equal(db.prepare('SELECT count(*) n FROM messages').get().n,6);
});
test('statistics, filtered drill-down, hidden edits and multi-account distinct chats agree across worker IPC',async t=>{
 const {store,request}=await fixture(t),f={from:1700000000,to:1700000002};
 const total=await request('stats',f);assert.equal(total.summary.total,4);assert.equal(total.summary.chats,2);assert.equal(total.summary.sent,2);
 assert.equal(total.hours.reduce((n,r)=>n+r.count,0),4);assert.equal(total.months.reduce((n,r)=>n+r.count,0),4);
 const all=await request('statMessages',{...f,limit:2}),older=await request('statMessages',{...f,limit:2,before:all.next});
 assert.equal(new Set([...all.items,...older.items].map(x=>x.rowid)).size,4);
 const scoped={...f,account:'a',chat:'p'};
 assert.equal((await request('stats',scoped)).summary.total,2);
 const rowid=store.db.prepare("SELECT rowid FROM messages WHERE account='a' AND id='2'").get().rowid;
 store.edit({account:'a',rowid,text:null,note:'',hidden:true,ts:1700000001});
 assert.equal((await request('stats',scoped)).summary.total,1);assert.equal((await request('statMessages',scoped)).items.length,1);
});
test('media metadata pages are bounded and diagnostic payload excludes IDs, keys, text and paths',async t=>{
 const {request,store}=await fixture(t);
 const media=await request('mediaIndex',{account:'a',from:1700000000,limit:1});
 assert.equal(media.items[0].kind,'voice');
 const previous=await request('mediaIndex',{account:'a',limit:1,before:media.next});
 assert.equal(previous.items[0].kind,'image');assert.doesNotMatch(previous.items[0].preview,/<img/);
 const diag=await request('diagnostics','a');
 assert.deepEqual(diag.current,{messages:3,contacts:3,sessions:3});assert.equal(diag.workspace.sessions,5);
 assert.equal(diag.sync,'unknown');assert.equal(diag.gaps,null);
 store.db.exec("CREATE TABLE wechat_sync_gaps(account TEXT,resolved_at INTEGER);INSERT INTO wechat_sync_gaps VALUES('a',NULL)");
 const gaps=await request('diagnostics','a');assert.equal(gaps.sync,'gaps');assert.equal(gaps.gaps,1);
 assert.doesNotMatch(JSON.stringify(gaps),/synthetic|李同学|workspace\.sqlite|sender|message_id/);
});
test('media protocol reports missing file, missing credential, unreadable metadata and unsupported header distinctly',async t=>{
 const {dir}=await fixture(t);
 const root=fs.realpathSync(dir),crypto=require('node:crypto'),hash='a'.repeat(32),chat='p',ts=1700000001;
 const month=new Date(ts*1000),part=month.getFullYear()+'-'+String(month.getMonth()+1).padStart(2,'0');
 const row={chat,ts,kind:'image',text:`<msg><img md5="${hash}" /></msg>`};
 const request=new Request('mw-media://archive/'+accountFor(root).slice(7)+'/1/preview',{method:'HEAD'});
 const probe=async (metadataBlocked,candidate=row)=>{let result;const response=await mediaResponse(request,async()=>({root,row:candidate,metadataBlocked,onOutcome:r=>{result=r}}));return {status:response.status,result}};
 assert.deepEqual(await probe(null),{status:404,result:'resourceMissing'});
 assert.equal((await probe('mediaKeyMissing')).result,'mediaKeyMissing');
 const noHint={...row,text:'<msg><img /></msg>'};
 assert.equal((await probe('mediaKeyMissing',noHint)).result,'mediaKeyMissing');
 assert.equal((await probe('mediaDatabaseUnreadable',noHint)).result,'mediaDatabaseUnreadable');
 const parent=path.join(root,'msg','attach',crypto.createHash('md5').update(chat).digest('hex'),part,'Img');
 fs.mkdirSync(parent,{recursive:true});fs.writeFileSync(path.join(parent,hash+'.jpg'),'synthetic unsupported file format');
 assert.equal((await probe(null)).result,'formatUnsupported');
 assert.equal((await probe('mediaKeyMissing')).result,'formatUnsupported');
 const v2=Buffer.alloc(48);Buffer.from([7,8,86,50,8,7]).copy(v2);v2.writeUInt32LE(4294967295,6);
 for(const [name,hasCode,expected] of [['missing',false,'imageKeyMissing'],['wrong',true,'decryptFailed']]){
  const base=path.join(root,name),r=path.join(base,'xwechat_files','wxid_synthetic'),folder=path.join(r,'msg','attach',crypto.createHash('md5').update(chat).digest('hex'),part,'Img');
  fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,hash+'.dat'),v2);
  if(hasCode){const kv=path.join(base,'app_data','net','kvcomm');fs.mkdirSync(kv,{recursive:true});fs.writeFileSync(path.join(kv,'key_873_fixture.statistic'),'')}
  let outcome;const res=await mediaResponse(new Request('mw-media://archive/'+accountFor(r).slice(7)+'/1/preview',{method:'HEAD'}),async()=>({root:r,row,onOutcome:r=>{outcome=r}}));
  assert.equal(res.status,404);assert.equal(outcome,expected);
 }
});
