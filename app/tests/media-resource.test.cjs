const {test}=require('node:test'),assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{createHash}=require('node:crypto');
const {WeChatMediaDB}=require('../electron/wechat-media-db.cjs'),{resolveAsset}=require('../electron/message-media.cjs');
const resource='b'.repeat(32),xml='a'.repeat(32),row={chat:'synthetic-resource-chat',ts:1700000000,kind:'image',source_local_id:'7',text:`<msg><img md5="${xml}"/></msg>`};
function fixture(){const db=new DatabaseSync(':memory:');db.exec(`CREATE TABLE dir2id(username TEXT);CREATE TABLE image_hardlink_info_v4(md5 TEXT,file_name TEXT,dir1 INTEGER,dir2 INTEGER);CREATE TABLE video_hardlink_info_v4(md5 TEXT,file_name TEXT,dir1 INTEGER,dir2 INTEGER);CREATE TABLE ChatName2Id(user_name TEXT);INSERT INTO ChatName2Id VALUES('${row.chat}');CREATE TABLE MessageResourceInfo(message_id INTEGER,chat_id INTEGER,message_local_id INTEGER,message_create_time INTEGER,message_local_type INTEGER,packed_info BLOB);CREATE TABLE MessageResourceDetail(message_id INTEGER,type INTEGER,size INTEGER,status INTEGER);`);db.prepare('INSERT INTO MessageResourceInfo VALUES(1,1,7,?,3,?)').run(row.ts,Buffer.concat([Buffer.from([18,34,10,32]),Buffer.from(resource)]));db.exec('INSERT INTO MessageResourceDetail VALUES(1,262145,32,1)');const media=new WeChatMediaDB('synthetic');const secrets=[];media.query=async(_r,key,relative,sql)=>{secrets.push({key,relative});return db.prepare(sql).all()};return{db,media,secrets};}
test('exact chat/local-id/time/type resource association resolves a filename identity distinct from XML MD5',async()=>{const{db,media,secrets}=fixture();try{const result=await media.locateDetailed('/synthetic','MEDIA',row,'preview',{sourceSecret:'SOURCE'});assert.equal(result.links.length,1);assert.equal(result.links[0].resource.id,resource);assert.equal(result.links[0].resource.sizes.thumbnail,32);assert.ok(secrets.filter(x=>x.relative.startsWith('message/')).every(x=>x.key==='SOURCE'));assert.ok(secrets.filter(x=>x.relative.startsWith('hardlink/')).every(x=>x.key==='MEDIA'));}finally{db.close()}});
test('wrong conversation, local id, timestamp or message type cannot borrow a resource',async()=>{const{db,media}=fixture();try{for(const changed of [{chat:'different'},{source_local_id:'8'},{ts:row.ts+1},{kind:'video',text:`<msg><videomsg md5="${xml}"/></msg>`}])assert.equal((await media.locateDetailed('/synthetic','MEDIA',{...row,...changed},'preview',{sourceSecret:'SOURCE'})).links.length,0);}finally{db.close()}});
test('ambiguous associations and unknown packed layouts fail closed',async()=>{const{db,media}=fixture();try{db.exec("INSERT INTO MessageResourceInfo SELECT 2,chat_id,message_local_id,message_create_time,message_local_type,x'00' FROM MessageResourceInfo");assert.equal((await media.locateDetailed('/synthetic','MEDIA',row,'preview',{sourceSecret:'SOURCE'})).links.length,0);db.exec('DELETE FROM MessageResourceInfo WHERE rowid=2');db.prepare('UPDATE MessageResourceInfo SET packed_info=?').run(Buffer.alloc(36));assert.equal((await media.locateDetailed('/synthetic','MEDIA',row,'preview',{sourceSecret:'SOURCE'})).links.length,0);}finally{db.close()}});
test('unavailable source credentials are never replaced with media credentials',async()=>{const{db,media,secrets}=fixture();try{assert.equal((await media.locateDetailed('/synthetic','MEDIA',row,'preview')).links.length,0);assert.ok(secrets.every(x=>x.relative==='hardlink/hardlink.db'));}finally{db.close()}});
test('incomplete and duplicate resource variants cannot authorize files',async()=>{for(const sql of ['UPDATE MessageResourceDetail SET status=0','UPDATE MessageResourceDetail SET size=0','INSERT INTO MessageResourceDetail SELECT * FROM MessageResourceDetail']){const{db,media}=fixture();try{db.exec(sql);assert.equal((await media.locateDetailed('/synthetic','MEDIA',row,'preview',{sourceSecret:'SOURCE'})).links.length,0);}finally{db.close()}}});
test('resource file requires exact conversation, month, size and valid image header; success clears old failure diagnostics',async()=>{const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mw-resource-')));const chatHash=createHash('md5').update(row.chat).digest('hex'),date=new Date(row.ts*1000),month=date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0');const folder=path.join(root,'msg/attach',chatHash,month,'Img');const bytes=Buffer.concat([Buffer.from('ffd8ffe000104a464946000101','hex'),Buffer.alloc(20)]);await fs.mkdir(folder,{recursive:true});await fs.writeFile(path.join(folder,resource+'_t.dat'),bytes);const r={id:resource,chatHash,month,sizes:{thumbnail:bytes.length}};try{for(const changed of [{chatHash:'c'.repeat(32)},{month:'1999-01'},{id:'../'+resource},{sizes:{thumbnail:bytes.length+1}}]){const diagnostics={};assert.equal(await resolveAsset(root,row,'preview',{links:[{resource:{...r,...changed}}],diagnostics}),null);}const diagnostics={reason:'oldFailure'};const a=await resolveAsset(root,row,'preview',{links:[{resource:r}],diagnostics});assert.equal(a.mime,'image/jpeg');assert.equal(diagnostics.reason,null);await a.handle.close();}finally{await fs.rm(root,{recursive:true,force:true})}});
test('archive media lookup carries stable source association and original timestamp without changing local edits',()=>{const {Store}=require('../electron/store.cjs');const store=new Store(':memory:');try{store.importData({version:1,account:{id:'synthetic-account',name:'Synthetic'},contacts:[{id:row.chat,name:'Synthetic'}],messages:[{id:'synthetic-message',chat:row.chat,sender:row.chat,timestamp:row.ts,kind:'image',text:row.text,outgoing:false}]});store.db.exec('CREATE TABLE wechat_sources(account TEXT,message_id TEXT,db_relative TEXT,source_local_id TEXT,PRIMARY KEY(account,message_id))');store.db.prepare('INSERT INTO wechat_sources VALUES(?,?,?,?)').run('synthetic-account','synthetic-message','message/message_1.db','7');const message=store.messages({account:'synthetic-account',chat:row.chat})[0];store.edit({account:message.account,rowid:message.rowid,text:row.text,note:'synthetic note',hidden:false,ts:row.ts+1000});const media=store.mediaMessage({account:message.account,rowid:message.rowid});assert.equal(media.ts,row.ts);assert.equal(media.source_local_id,'7');assert.equal(media.db_relative,'message/message_1.db');assert.equal(store.messages({account:message.account,chat:row.chat})[0].ts,row.ts+1000);assert.equal(store.mediaMessage({account:'other-account',rowid:message.rowid}),undefined);}finally{store.close()}});

async function resourceResponse(t,configure,mediaKey='MEDIA',mediaRow=row){
 const {db,media,secrets}=fixture();
 t.after(()=>db.close());
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mw-media-fallback-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const chatHash=createHash('md5').update(row.chat).digest('hex'),date=new Date(row.ts*1000);
 const month=date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0');
 const folder=path.join(root,'msg','attach',chatHash,month,'Img');
 const bytes=Buffer.concat([Buffer.from('ffd8ffe000104a464946000101','hex'),Buffer.alloc(20)]);
 db.prepare('UPDATE MessageResourceDetail SET size=?').run(bytes.length);
 await fs.mkdir(folder,{recursive:true});
 await fs.writeFile(path.join(folder,resource+'_t.dat'),bytes);
 await configure?.({db,media,folder,chatHash,month});
 const {accountFor,mediaResponse}=require('../electron/message-media.cjs');
 const account=accountFor(root);
 let outcome;
 const response=await mediaResponse(new Request('mw-media://archive/'+account.slice(7)+'/1/preview'),async(requestedAccount,id)=>{
  assert.equal(requestedAccount,account);assert.equal(id,1);
  const {links,reason}=await media.locateDetailed(root,mediaKey,mediaRow,'preview',{sourceSecret:'SOURCE'});
  return {root,row:mediaRow,links,metadataBlocked:reason,onOutcome:status=>outcome=status};
 });
 return {response,bytes,secrets,outcome};
}

test('stale exact hardlink still falls back to the uniquely bound local resource',async t=>{
 const {response,bytes,outcome}=await resourceResponse(t,({db,chatHash,month})=>{
  db.prepare('INSERT INTO dir2id VALUES(?),(?)').run(chatHash,month);
  db.prepare('INSERT INTO image_hardlink_info_v4 VALUES(?,?,1,2)').run(xml,'c'.repeat(32)+'.dat');
 });
 assert.equal(response.status,200);assert.equal(outcome,'readable');
 assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
});

test('unavailable or incompatible hardlink cannot block an independently readable resource',async t=>{
 for(const problem of ['MEDIA_SNAPSHOT_FAILED','schema']){
  const {response,bytes}=await resourceResponse(t,({db,media})=>{
   if(problem==='schema'){db.exec('DROP TABLE image_hardlink_info_v4; CREATE TABLE image_hardlink_info_v4(unsupported TEXT)');return;}
   const query=media.query;
   media.query=async(root,key,relative,sql)=>{
    if(relative==='hardlink/hardlink.db')throw Object.assign(Error('fixture missing database'),{code:problem});
    return query(root,key,relative,sql);
   };
  });
  assert.equal(response.status,200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
 }
});

test('a source-only credential opens only the resource database and can serve the media',async t=>{
 const {response,bytes,secrets}=await resourceResponse(t,null,null);
 assert.equal(response.status,200);
 assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
 assert.ok(secrets.length>0 && secrets.every(x=>x.relative==='message/message_resource.db' && x.key==='SOURCE'));
});

test('unreadable hardlink is not reported as a missing file when the independent association does not match',async t=>{
 const {response,outcome}=await resourceResponse(t,({db})=>db.exec('DROP TABLE image_hardlink_info_v4'),'MEDIA',{...row,source_local_id:'99'});
 assert.equal(response.status,404);assert.equal(outcome,'mediaSchemaUnsupported');
});
