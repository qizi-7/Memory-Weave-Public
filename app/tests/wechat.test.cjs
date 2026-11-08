const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {execFileSync,spawn}=require('node:child_process');const {Store}=require('../electron/store.cjs');const {readQuery,importWeChat,normalize}=require('../electron/wechat-adapter.cjs');
const helper=path.resolve('native/.build/wechat-reader');
const fixtures=fs.mkdtempSync(path.join(os.tmpdir(),'weave-generated-fixtures-'));
const fixture=name=>path.join(fixtures,name);
const fixtureKey='ab'.repeat(32);

before(async()=>{
 const writer=path.resolve('native/.build/encrypted-fixture');
 for(const name of ['contact','message']){
  execFileSync(writer,[fixture(name+'.db'),name],{input:fixtureKey});
 }
 const live=fixture('contact-live.db');
 fs.copyFileSync(fixture('contact.db'),live);
 const walWriter=spawn(path.resolve('native/.build/wal-writer'),[live],{stdio:['pipe','pipe','ignore']});
 const ready=new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('合成 WAL 夹具未就绪')),10000);
  walWriter.once('error',error=>{clearTimeout(timer);reject(error)});
  walWriter.once('exit',code=>{clearTimeout(timer);reject(Error('合成 WAL 写入失败 '+code))});
  walWriter.stdout.once('data',data=>{
   clearTimeout(timer);
   if(data.toString().trim()==='READY')resolve();
   else reject(Error('合成 WAL 状态无效'));
  });
 });
 walWriter.stdin.on('error',()=>{});
 walWriter.stdin.write(fixtureKey+'\n');
 try{
  await ready;
  fs.copyFileSync(live,fixture('contact-wal.db'));
  fs.copyFileSync(live+'-wal',fixture('contact-wal.db-wal'));
 }finally{
  walWriter.stdin.end('STOP\n');
 }
});
after(()=>fs.rmSync(fixtures,{recursive:true,force:true}));
const {createSnapshot}=require('../electron/wechat-snapshot.cjs');
test('committed encrypted WAL with 4 MiB preallocated tail is read from private copy without source writes',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'weave-wal-test-'));const key='ab'.repeat(32);const store=new Store(':memory:');let snapshot;
 try{
  const data=path.join(root,'db_storage'),contact=path.join(data,'contact/contact.db');fs.mkdirSync(path.dirname(contact),{recursive:true});fs.mkdirSync(path.join(data,'message'),{recursive:true});
  fs.copyFileSync(fixture('contact-wal.db'),contact);fs.copyFileSync(fixture('contact-wal.db-wal'),contact+'-wal');fs.truncateSync(contact+'-wal',4*1024*1024);fs.copyFileSync(fixture('message.db'),path.join(data,'message/message_0.db'));
  const digest=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');const before=[digest(contact),digest(contact+'-wal')];
  snapshot=await createSnapshot(data,['contact/contact.db']);assert.equal(snapshot.walFiles,1);
  const copied=path.join(snapshot.root,'contact/contact.db');const rows=await readQuery(helper,copied,key,'4','SELECT * FROM contact',{privateCopy:true});assert.equal(rows[0].nick_name,'WAL中新昵称');
  const result=await importWeChat(store,{root,key,selfId:'test-self',profile:'4'},helper);assert.equal(result.added,2);assert.equal(result.walFiles,1);assert.equal(result.mode,'validated-private-copy');
  assert.deepEqual([digest(contact),digest(contact+'-wal')],before);assert.equal(fs.existsSync(contact+'-shm'),false);
  await snapshot.cleanup();assert.equal(fs.existsSync(snapshot.root),false);snapshot=null;
 }finally{if(snapshot)await snapshot.cleanup();store.close();fs.rmSync(root,{recursive:true,force:true});}
});
test('empty key requires explicit plaintext mode and invalid WAL is rejected without writes',async()=>{
 const store=new Store(':memory:');try{await assert.rejects(importWeChat(store,{root:'/unused',selfId:'test-self'},helper),/请输入数据库密钥/);assert.equal(store.accounts().length,0);}finally{store.close();}
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'weave-invalid-wal-'));try{fs.writeFileSync(path.join(root,'test.db'),'test-db');fs.writeFileSync(path.join(root,'test.db-wal'),'incomplete');await assert.rejects(createSnapshot(root,['test.db']),/日志头部无法识别/);assert.equal(fs.readFileSync(path.join(root,'test.db-wal'),'utf8'),'incomplete');}finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('source change during capture rejects the copy before importing',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'weave-changing-source-'));const source=path.join(root,'test.db');fs.writeFileSync(source,'original bytes');
 const copy=fs.promises.copyFile;let changed=false;
 fs.promises.copyFile=async(...args)=>{await copy(...args);if(!changed){changed=true;fs.writeFileSync(source,'new source bytes')}};
 try{await assert.rejects(createSnapshot(root,['test.db']),/数据发生变化/);assert.equal(fs.readFileSync(source,'utf8'),'new source bytes');}
 finally{fs.promises.copyFile=copy;fs.rmSync(root,{recursive:true,force:true});}
});
test('encrypted WeChat-shaped fixture imports read-only; wrong key/write/WAL rejected',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'weave-encrypted-test-'));const key='ab'.repeat(32);const store=new Store(':memory:');
 try{
  const contact=path.join(root,'db_storage/contact/contact.db'),message=path.join(root,'db_storage/message/message_0.db');fs.mkdirSync(path.dirname(contact),{recursive:true});fs.mkdirSync(path.dirname(message),{recursive:true});
  fs.copyFileSync(fixture('contact.db'),contact);fs.copyFileSync(fixture('message.db'),message);
  const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');const before=[hash(contact),hash(message)];
  assert.notEqual(fs.readFileSync(contact).subarray(0,16).toString(),'SQLite format 3\0');
  const rows=await readQuery(helper,contact,key,'4','SELECT * FROM contact');assert.equal(rows[0].nick_name,'测试联系人');
  await assert.rejects(readQuery(helper,contact,'cd'.repeat(32),'4','SELECT * FROM contact'));
  await assert.rejects(readQuery(helper,contact,key,'4',"DELETE FROM contact"));await assert.rejects(readQuery(helper,contact,key,'4','SELECT 1; SELECT 2;'));
  const r=await importWeChat(store,{root,key,profile:'4',selfId:'test-self',displayName:'隔离测试'},helper);assert.equal(r.added,2);assert.equal(store.stats(r.account).summary.sent,1);assert.equal((await importWeChat(store,{root,key,profile:'4',selfId:'test-self'},helper)).added,0);
  assert.deepEqual([hash(contact),hash(message)],before);
  fs.writeFileSync(contact+'-wal','test-wal');await assert.rejects(readQuery(helper,contact,key,'4','SELECT * FROM contact'),/WAL/);
 }finally{store.close();fs.rmSync(root,{recursive:true,force:true});}
});
test('normalizer preserves 64-bit source identity and decodes zstd text',()=>{const z=require('node:zlib');const b=z.zstdCompressSync(Buffer.from('中文原文'));const m=normalize({local_id:'9223372036854775800',create_time:'1700000000',local_type:'1',message_content:{$hex:b.toString('hex')},sender_username:'self'},{self:'self',chat:'peer',relative:'message/message_0.db',table:'Msg_x',senders:new Map()});assert.equal(m.text,'中文原文');assert.match(m.id,/9223372036854775800$/);assert.equal(m.outgoing,true);});

test('import resolves the account from matching local profile without a manually entered wxid',async()=>{
 const parent=fs.mkdtempSync(path.join(os.tmpdir(),'weave-identity-test-'));
 const root=path.join(parent,'test-self_abcd'),key='ab'.repeat(32),store=new Store(':memory:');
 try{
  const profileDir=path.join(parent,'all_users/config');
  fs.mkdirSync(profileDir,{recursive:true});
  const field=Buffer.from('mmkv_key_user_name'),value=Buffer.from('test-self');
  const record=Buffer.concat([Buffer.from([field.length]),field,Buffer.from([value.length+1,value.length]),value]);
  const cipher=crypto.createCipheriv('aes-128-cfb',Buffer.from('xwechat_crypt_key').subarray(0,16),Buffer.alloc(16));
  fs.writeFileSync(path.join(profileDir,'global_config'),Buffer.concat([Buffer.alloc(4),cipher.update(record),cipher.final()]));
  fs.mkdirSync(path.join(root,'db_storage/contact'),{recursive:true});
  fs.mkdirSync(path.join(root,'db_storage/message'),{recursive:true});
  fs.copyFileSync(fixture('contact.db'),path.join(root,'db_storage/contact/contact.db'));
  fs.copyFileSync(fixture('message.db'),path.join(root,'db_storage/message/message_0.db'));
  await assert.rejects(importWeChat(store,{root,key:'cd'.repeat(32)},helper),/无法打开通讯录数据库.*4、3/);
  const result=await importWeChat(store,{root,key},helper);
  assert.equal(result.selfId,'test-self');
  assert.equal(store.stats(result.account).summary.sent,1);
  const unrelated=path.join(parent,'another-account_abcd');
  fs.renameSync(root,unrelated);
  await assert.rejects(importWeChat(store,{root:unrelated,key},helper),/无法确认本人 wxid/);
 }finally{store.close();fs.rmSync(parent,{recursive:true,force:true});}
});

test('database key maps bind entries to relative paths and verify supplied salts',()=>{
 const {keysForDatabases}=require('../electron/wechat-keys.cjs');
 const file=fixture('contact.db'),salt=fs.readFileSync(file).subarray(0,16).toString('hex');
 const contact='ab'.repeat(32),message='cd'.repeat(32);
 const getKey=keysForDatabases(JSON.stringify({
  'contact/contact.db':{enc_key:contact,salt},
  'message/message_0.db':{key_hex:message}
 }));
 assert.equal(getKey('contact/contact.db',file),contact);
 assert.equal(getKey('message/message_0.db',file),message);
 assert.throws(()=>getKey('message/message_1.db',file),/逐库密钥缺失/);
 const wrapped=keysForDatabases("x'"+contact+salt+"'");
 assert.equal(wrapped('contact/contact.db',file),contact);
 assert.throws(()=>wrapped('message/message_0.db',fixture('message.db')),/salt 与数据库不匹配/);
});

test('imports more than 20,000 contacts and resolves a sender beyond the first page',async()=>{
 const {DatabaseSync}=require('node:sqlite');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'weave-large-contact-'));
 const store=new Store(':memory:');
 try{
  const contactDir=path.join(root,'db_storage/contact'),messageDir=path.join(root,'db_storage/message');
  fs.mkdirSync(contactDir,{recursive:true});fs.mkdirSync(messageDir,{recursive:true});
  const contact=new DatabaseSync(path.join(contactDir,'contact.db'));
  try{
   contact.exec("CREATE TABLE contact(username TEXT,nick_name TEXT); WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<20001) INSERT INTO contact SELECT 'peer-'||i,'Person '||i FROM n;");
  }finally{contact.close();}
  const message=new DatabaseSync(path.join(messageDir,'message_0.db'));
  try{
   const table='Msg_'+crypto.createHash('md5').update('peer-20001').digest('hex');
   message.exec("CREATE TABLE Name2Id(user_name TEXT); WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<20001) INSERT INTO Name2Id SELECT 'sender-'||i FROM n;");
   message.exec(`CREATE TABLE ${table}(local_id INTEGER,create_time INTEGER,message_content TEXT,local_type INTEGER,real_sender_id INTEGER); INSERT INTO ${table} VALUES(1,1700000000,'test',1,20001),(1,1700000001,hex(zeroblob(60000)),1,20001),(3,-1,'invalid',1,20001)`);
  }finally{message.close();}
  const progress=[];
  const result=await importWeChat(store,{root,selfId:'sender-20001',allowDecrypted:true},helper,value=>progress.push(value));
  assert.ok(progress.some(p=>p.stage.includes('密钥已通过')));
  assert.ok(progress.some(p=>p.stage==='正在导入聊天记录'&&p.scanned===3&&p.added===2&&p.skipped===1));
  assert.equal(result.added,2);
  assert.match(result.warnings.join(' '),/1 条消息因时间或内容无效/);
  assert.match(result.warnings.join(' '),/1 条消息使用数据库行号/);
  assert.equal(store.db.prepare('SELECT MAX(length(text)) AS length FROM messages').get().length,120000);
  assert.equal((await importWeChat(store,{root,selfId:'sender-20001',allowDecrypted:true},helper)).added,0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM contacts').get().count,20001);
  assert.equal(store.stats(result.account).summary.sent,2);
 }finally{store.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('progressive sync publishes the latest 30 before history and resumes committed cursors',async()=>{
 const {DatabaseSync}=require('node:sqlite');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'weave-progressive-'));
 const workspace=path.join(root,'workspace.sqlite');
 let store=new Store(workspace);
 try{
  const contactDir=path.join(root,'db_storage/contact'),messageDir=path.join(root,'db_storage/message');
  fs.mkdirSync(contactDir,{recursive:true});fs.mkdirSync(messageDir,{recursive:true});
  const contact=new DatabaseSync(path.join(contactDir,'contact.db'));
  contact.exec("CREATE TABLE contact(username TEXT,nick_name TEXT); INSERT INTO contact VALUES('peer','Peer');");contact.close();
  const message=new DatabaseSync(path.join(messageDir,'message_0.db'));
  const table='Msg_'+crypto.createHash('md5').update('peer').digest('hex');
  const now=Math.floor(Date.now()/1000);
  message.exec(`CREATE TABLE ${table}(local_id INTEGER PRIMARY KEY,create_time INTEGER,message_content TEXT,local_type INTEGER,is_send INTEGER);
   WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<1200)
   INSERT INTO ${table} SELECT i,${now}-CASE WHEN i<600 THEN 4000000 ELSE 0 END+i-1200,'test line end',1,0 FROM n;`);
  message.close();
  const args={root,selfId:'self',allowDecrypted:true};
  let cancelled=false,firstReady=false,pause=false,release;
  let pauseReached;
  const stoppedAtGate=new Promise(resolve=>{pauseReached=resolve});
  const importRun=importWeChat(store,args,helper,p=>{
   if(p.ready&&p.stage==='加载会话近期消息'&&!firstReady){
    firstReady=true;
    assert.equal(store.db.prepare('SELECT count(*) n FROM messages').get().n,30);
    assert.equal(store.db.prepare('SELECT min(ts) t FROM messages').get().t,now-29);
    pause=true;
   }
   if(p.stage==='补齐最近 30 天'&&p.scanned>=530)cancelled=true;
  },{wait:async()=>{
   if(pause)await new Promise(resolve=>{release=resolve;pauseReached()});
   if(cancelled)throw Error('test stop');
  }});
  const stopped=assert.rejects(importRun,/test stop/);
  await Promise.race([stoppedAtGate,importRun]);
  assert.equal(store.db.prepare('SELECT count(*) n FROM messages').get().n,30);
  pause=false;release();
  await stopped;
  assert.ok(firstReady);
  assert.equal(store.db.prepare('SELECT count(*) n FROM messages').get().n,530);
  store.close();store=new Store(workspace);
  const phases=new Map();
  const result=await importWeChat(store,args,helper,event=>{
   if(event.totalTables) {
    assert.ok(event.doneTables<=event.totalTables);
    phases.set(event.phase,event.doneTables===event.totalTables);
   }
  },{wait:async()=>{}});
  assert.deepEqual([...phases],[['recent',true],['history',true]]);
  assert.equal(result.added,670);
  assert.equal(result.scanned,1200);
  assert.equal(store.db.prepare('SELECT text FROM messages LIMIT 1').get().text,'test\u2028line\u2029end');
  assert.equal(store.db.prepare('SELECT count(*) n FROM messages').get().n,1200);
  store.db.exec('DELETE FROM wechat_sync_cursor');
  const migrated=await importWeChat(store,args,helper,()=>{},{wait:async()=>{}});
  assert.equal(migrated.added,0);
  assert.equal(migrated.scanned,30); // Preview only. The proven legacy range is excluded from history.
  store.db.exec("DELETE FROM wechat_sync_cursor; DELETE FROM messages WHERE id LIKE '%:17'");
  const sparse=await importWeChat(store,args,helper,()=>{},{wait:async()=>{}});
  assert.equal(sparse.added,1);
  assert.equal(store.db.prepare('SELECT count(*) n FROM messages').get().n,1200);

 }finally{store.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('wide message payload shrinks the batch and isolates oversized rows',async()=>{
 const {DatabaseSync}=require('node:sqlite');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'weave-wide-payload-')),store=new Store(':memory:');
 try{
  for(const section of ['contact','message'])fs.mkdirSync(path.join(root,'db_storage',section),{recursive:true});
  const contact=new DatabaseSync(path.join(root,'db_storage/contact/contact.db'));
  contact.exec("CREATE TABLE contact(username TEXT); INSERT INTO contact VALUES('peer');");contact.close();
  const db=new DatabaseSync(path.join(root,'db_storage/message/message_0.db'));
  const table='Msg_'+crypto.createHash('md5').update('peer').digest('hex');
  db.exec(`CREATE TABLE ${table}(local_id INTEGER PRIMARY KEY,create_time INTEGER,message_content,unused_media BLOB);
    WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<20)
    INSERT INTO ${table} SELECT i,1700000000+i,CAST(x'ff'||zeroblob(2097151) AS BLOB),NULL FROM n;
    INSERT INTO ${table} VALUES(21,1700000021,'small',zeroblob(9000000)),(22,1700000022,zeroblob(5000000),NULL);`);
  db.close();
  const result=await importWeChat(store,{root,selfId:'self',allowDecrypted:true},helper,()=>{},{wait:async()=>{}});
  assert.equal(result.added,2);
  assert.match(result.warnings.join(' '),/待重试/);
  assert.equal(result.failedTables,1);
  assert.deepEqual({...store.db.prepare('SELECT row_id,kind FROM wechat_sync_retry WHERE resolved_at IS NULL').get()},{row_id:'1',kind:'ROW_GAPS'});
  assert.equal(store.db.prepare('SELECT count(*) n FROM wechat_sync_window').get().n,1);
  const diagnostic=store.db.prepare("SELECT * FROM wechat_sync_errors WHERE kind='PAGE_BYTES'").get();
  assert.ok(diagnostic);
  assert.match(diagnostic.source,/message_0\.db:Msg_/);
  assert.ok(diagnostic.bytes<=16*1024*1024);
  assert.equal(store.db.prepare('SELECT count(*) n FROM wechat_sync_gaps WHERE resolved_at IS NULL').get().n,20);
 }finally{store.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('unreadable conversation schema leaves a retry window and other tables commit',async()=>{
 const {DatabaseSync}=require('node:sqlite');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'weave-failed-table-'));
 const store=new Store(':memory:');
 try{
  fs.mkdirSync(path.join(root,'db_storage/contact'),{recursive:true});
  fs.mkdirSync(path.join(root,'db_storage/message'),{recursive:true});
  const contacts=new DatabaseSync(path.join(root,'db_storage/contact/contact.db'));
  contacts.exec("CREATE TABLE contact(username TEXT,nick_name TEXT); INSERT INTO contact VALUES('peer','Peer');");
  contacts.close();
  const source=new DatabaseSync(path.join(root,'db_storage/message/message_0.db'));
  const good='Msg_'+crypto.createHash('md5').update('peer').digest('hex');
  const bad='Msg_'+'0'.repeat(32);
  source.exec(`CREATE TABLE ${bad}(local_id INTEGER PRIMARY KEY);
   CREATE TABLE ${good}(local_id INTEGER PRIMARY KEY,create_time INTEGER,message_content TEXT,local_type INTEGER);
   INSERT INTO ${good} VALUES(1,1700000000,'valid',1)`);
  source.close();
  const result=await importWeChat(store,{root,allowDecrypted:true,selfId:'self'},helper,()=>{},{wait:async()=>{}});
  assert.equal(result.failedTables,1);
  assert.equal(result.added,1);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM wechat_sync_window').get().n,1);
  const diagnostic=store.db.prepare('SELECT * FROM wechat_query_diagnostics').get();
  assert.equal(diagnostic.kind,'SOURCE_SCHEMA');
  assert.match(diagnostic.source_id,/^[a-f0-9]{12}$/);
  assert.equal(diagnostic.checkpoint,null);
 }finally{store.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('isolated row is retried in its original table, even after that source snapshot changes',async()=>{
 const {DatabaseSync}=require('node:sqlite');
 const {sourceId}=require('../electron/wechat-sync-retry.cjs');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'weave-single-retry-')),store=new Store(':memory:');
 try{
  for(const section of ['contact','message'])fs.mkdirSync(path.join(root,'db_storage',section),{recursive:true});
  const contacts=new DatabaseSync(path.join(root,'db_storage/contact/contact.db'));
  contacts.exec("CREATE TABLE contact(username TEXT); INSERT INTO contact VALUES('peer'),('other');");contacts.close();
  const badFile=path.join(root,'db_storage/message/message_0.db');
  const bad='Msg_'+crypto.createHash('md5').update('peer').digest('hex');
  const good='Msg_'+crypto.createHash('md5').update('other').digest('hex');
  const now=Math.floor(Date.now()/1000);
  for(const [file,table,payload] of [[badFile,bad,"x'ff'"],[path.join(root,'db_storage/message/message_1.db'),good,"'good'"]]){
   const source=new DatabaseSync(file);
   source.exec(`CREATE TABLE ${table}(local_id INTEGER PRIMARY KEY,create_time INTEGER,message_content);
    INSERT INTO ${table} VALUES(1,${now},${payload});`);
   source.close();
  }
  const args={root,selfId:'self',allowDecrypted:true};
  const result=await importWeChat(store,args,helper,()=>{},{wait:async()=>{}});
  assert.equal(result.added,1);
  const pending=store.db.prepare('SELECT source,row_id,checkpoint FROM wechat_sync_retry WHERE resolved_at IS NULL').get();
  assert.equal(pending.row_id,'1');
  assert.ok(pending.checkpoint);
  assert.equal(store.db.prepare("SELECT scan_complete FROM wechat_sync_cursor WHERE phase='preview' AND done=0").get().scan_complete,1);
  const source=new DatabaseSync(badFile);
  source.exec(`UPDATE ${bad} SET message_content='repaired';`);
  source.close();
  const files=new Set();
  const retry=await importWeChat(store,{...args,retryFailed:true,retrySourceId:sourceId(pending.source)},helper,event=>{
   if(event.file?.startsWith('message/'))files.add(event.file);
  },{wait:async()=>{}});
  assert.deepEqual([...files],['message/message_0.db']);
  assert.equal(retry.targeted,true);
  assert.equal(retry.added,1);
  assert.equal(retry.saved,2);
  assert.equal(retry.failedTables,0);
  assert.equal(store.db.prepare('SELECT count(*) n FROM wechat_sync_window').get().n,1);
 }finally{store.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('continuous failures trip a finite breaker and keep pending rows and the sync window',async()=>{
 const {DatabaseSync}=require('node:sqlite');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'weave-reader-circuit-')),store=new Store(':memory:');
 try{
  for(const section of ['contact','message'])fs.mkdirSync(path.join(root,'db_storage',section),{recursive:true});
  const contacts=new DatabaseSync(path.join(root,'db_storage/contact/contact.db'));
  contacts.exec("CREATE TABLE contact(username TEXT); INSERT INTO contact VALUES('peer');");contacts.close();
  const source=new DatabaseSync(path.join(root,'db_storage/message/message_0.db'));
  for(let i=1;i<=13;i++){
   const table='Msg_'+String(i).padStart(32,'0');
   source.exec(`CREATE TABLE ${table}(local_id INTEGER PRIMARY KEY);`);
  }
  source.close();
  await assert.rejects(importWeChat(store,{root,selfId:'self',allowDecrypted:true},helper,()=>{},{wait:async()=>{}}),
   error=>error.code==='SYNC_CIRCUIT_OPEN');
  assert.equal(store.db.prepare('SELECT count(*) n FROM wechat_query_diagnostics').get().n,12);
  assert.equal(store.db.prepare('SELECT count(*) n FROM wechat_sync_window').get().n,1);
  assert.equal(store.db.prepare('SELECT count(*) n FROM wechat_sync_retry WHERE resolved_at IS NULL').get().n,12);
  assert.equal(store.db.prepare('SELECT count(*) n FROM messages').get().n,0);
 }finally{store.close();fs.rmSync(root,{recursive:true,force:true});}
});
