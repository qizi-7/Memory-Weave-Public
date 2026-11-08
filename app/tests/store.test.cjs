const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Store}=require('../electron/store.cjs');
// Synthetic fixtures are test-only, never loaded by the app.
const data=()=>({version:1,account:{id:'test-account',name:'测试账号'},contacts:[{id:'chat-1',name:'测试联系人'}],messages:[{id:'m1',chat:'chat-1',sender:'测试发送者',timestamp:1700000000,text:'一起讨论项目设计方案',outgoing:false,kind:'text'}]});
test('import is idempotent; validation fails before any account writes',()=>{
 const s=new Store(':memory:');try{assert.equal(s.importData(data()).added,1);assert.equal(s.importData(data()).added,0);const bad=data();bad.account.id='bad';bad.messages[0].chat='missing';assert.throws(()=>s.importData(bad));assert.equal(s.accounts().length,1);assert.equal(s.stats('test-account').summary.total,1)}finally{s.close()}
});
test('Chinese search, local edits, hiding and undo preserve original and update index',()=>{
 const s=new Store(':memory:');try{s.importData(data());assert.equal(s.find({account:'test-account',query:'项目设计'}).length,1);assert.equal(s.find({account:'test-account',query:'讨论'}).length,1);const m=s.messages({account:'test-account',chat:'chat-1'})[0];s.edit({account:m.account,rowid:m.rowid,text:'新的检索内容',note:'测试备注',hidden:false,ts:m.ts});assert.equal(s.find({account:m.account,query:'项目设计'}).length,0);assert.equal(s.find({account:m.account,query:'检索内容'}).length,1);assert.equal(s.messages({account:m.account,chat:m.chat})[0].original,m.text);s.edit({account:m.account,rowid:m.rowid,text:'新的检索内容',note:'',hidden:true,ts:m.ts});assert.equal(s.stats(m.account).summary.total,0);assert.equal(s.find({account:m.account,query:'检索内容'}).length,0);s.undo({account:m.account,rowid:m.rowid});assert.equal(s.stats(m.account).summary.total,1);s.undo({account:m.account,rowid:m.rowid});assert.equal(s.messages({account:m.account,chat:m.chat})[0].text,m.text);assert.equal(s.find({account:m.account,query:'项目设计'}).length,1)}finally{s.close()}
});
test('pagination and source location are stable for identical timestamps; accounts stay isolated',()=>{
 const s=new Store(':memory:');try{const d=data();d.messages=Array.from({length:240},(_,i)=>({...d.messages[0],id:'m'+i}));s.importData(d);const recent=s.messages({account:d.account.id,chat:'chat-1'});assert.equal(recent.length,100);const older=s.messages({account:d.account.id,chat:'chat-1',offset:100});assert.equal(older.length,100);assert.equal(new Set([...recent,...older].map(m=>m.rowid)).size,200);const byCursor=s.messages({account:d.account.id,chat:'chat-1',before:{ts:recent[0].ts,rowid:recent[0].rowid}});assert.deepEqual(byCursor.map(m=>m.rowid),older.map(m=>m.rowid));const p=s.locate({account:d.account.id,rowid:older[50].rowid});assert.equal(p.offset,100);assert.equal(s.contacts('other').length,0);assert.throws(()=>s.edit({account:'other',rowid:recent[0].rowid,text:'x',note:'',hidden:false,ts:1}));assert.throws(()=>s.messages({account:d.account.id,chat:'chat-1',offset:-1}));assert.equal(s.exportData({account:d.account.id}).length,240)}finally{s.close()}
});
test('database transaction rolls back a storage failure',()=>{
 const s=new Store(':memory:');try{s.db.exec("CREATE TRIGGER reject_message BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'forced'); END;");assert.throws(()=>s.importData(data()));assert.deepEqual(s.accounts(),[]);assert.equal(s.db.prepare('SELECT COUNT(*) n FROM search').get().n,0)}finally{s.close()}
});

test('session bootstrap lists archived and discovered chats without pulling unrelated contacts',()=>{
 const store=new Store(':memory:');
 try{
  const account={id:'sessions-test',name:'Test'};
  store.importData({version:1,account,contacts:[{id:'chat',name:'Chat'},{id:'discovered',name:'Discovered'},{id:'person',name:'Contact only'}],messages:[{id:'m1',chat:'chat',sender:'sender',timestamp:1700000000,text:'latest preview',outgoing:false,kind:'text'}]});
  store.registerSessions(account.id,['discovered']);
  assert.deepEqual(store.sessions(account.id).map(row=>[row.id,row.preview]),[['chat','latest preview'],['discovered','']]);
  assert.equal(store.contacts(account.id).length,3);
  assert.deepEqual(store.sessions('another'),[]);
  store.db.exec("DELETE FROM contacts WHERE id='chat'");
  assert.equal(store.sessions(account.id)[0].id,'chat');
 }finally{store.close();}
});

test('post-commit notifications have actual archive revision and exclude duplicate and rolled-back writes',()=>{
 const events=[];const s=new Store(':memory:',{messagesCommitted:event=>{assert.equal(s.db.isTransaction,false);events.push(event)}});
 try{
  const first=data();s.importData(first);assert.equal(events[0].added,1);assert.equal(events[0].account,first.account.id);
  assert.deepEqual(events[0].chats,[first.messages[0].chat]);assert.ok(events[0].revision>0);
  s.importData(first);assert.equal(events.length,1);
  const next=data();next.messages[0].id+='-next';
  assert.throws(()=>s.importData(next,{onCommit:()=>{throw Error('synthetic rollback')}}),/synthetic rollback/);
  assert.equal(events.length,1);assert.equal(s.stats(first.account.id).summary.total,1);
  s.importData(next);assert.equal(events.length,2);assert.ok(events[1].revision>events[0].revision);
 }finally{s.close()}
});
