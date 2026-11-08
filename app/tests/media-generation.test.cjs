const {test}=require('node:test'),assert=require('node:assert/strict');
const {WeChatMediaDB,mediaStamp,mediaFailure}=require('../electron/wechat-media-db.cjs');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
test('WAL generation refresh drains active readers without closing their snapshot',async()=>{
 let generation='one',opens=0,cleanups=[],release;
 const db=new WeChatMediaDB('fixture',{stamp:async()=>generation,open:async()=>{const id=++opens;return{query:async sql=>{if(sql==='slow')await new Promise(r=>release=r);return id},cleanup:async()=>cleanups.push(id)}}});
 const first=db.query('/synthetic','key','hardlink/hardlink.db','slow');
 while(!release)await new Promise(r=>setImmediate(r));
 generation='two';assert.equal(await db.query('/synthetic','key','hardlink/hardlink.db','new'),2);assert.deepEqual(cleanups,[]);
 release();assert.equal(await first,1);await db.close();assert.deepEqual(cleanups.sort(),[1,2]);
});
test('credential replacement and explicit close preserve an active query',async()=>{
 let release,cleanups=0;
 const db=new WeChatMediaDB('fixture',{stamp:async()=>'',open:async(_r,_p,key)=>({query:async()=>{if(key==='old')await new Promise(r=>release=r);return key},cleanup:async()=>{cleanups++}})});
 const old=db.query('/synthetic','old','hardlink/hardlink.db','read');while(!release)await new Promise(r=>setImmediate(r));
 assert.equal(await db.query('/synthetic','new','hardlink/hardlink.db','read'),'new');const closing=db.close();release();assert.equal(await old,'old');await closing;assert.equal(cleanups,2);
});
test('late WAL and source replacement invalidate snapshot identity',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'mw-stamp-'));await fs.mkdir(path.join(root,'db_storage'));
 const file=path.join(root,'db_storage/index.db');try{await fs.writeFile(file,'same');const a=await mediaStamp(root,'index.db');await fs.writeFile(file+'-wal','wal');const b=await mediaStamp(root,'index.db');assert.notEqual(a,b);await fs.rename(file,file+'.old');await fs.writeFile(file,'same');assert.notEqual(b,await mediaStamp(root,'index.db'));}finally{await fs.rm(root,{recursive:true,force:true})}
});
test('v3/v4 schema detection queries both exact identities and never uses a broad prefix',async()=>{
 for(const versions of [[3],[4],[3,4]]){
 const db=new WeChatMediaDB('fixture');let sqls=[];
 db.query=async(_r,_s,_d,sql)=>{sqls.push(sql);if(sql.includes('sqlite_master'))return versions.map(v=>({name:`video_hardlink_info_v${v}`}));if(sql.startsWith('PRAGMA'))return ['md5','file_name','dir1','dir2'].map(name=>({name}));return [{md5:'a'.repeat(32),file_name:'exact.mp4',first:'2026-11',second:''}]};
 const result=await db.locateDetailed('/synthetic','key',{kind:43,text:`<msg><videomsg md5="${'a'.repeat(32)}"/></msg>`,chat:'synthetic',ts:1700000000});assert.equal(result.links.length,1);assert.ok(sqls.every(s=>!s.includes('LIKE')));
 }
});
test('media failures retain distinct credential, timeout, snapshot and schema stages',()=>{
 assert.equal(new Set(['MEDIA_KEY_MISMATCH','NATIVE_TIMEOUT','MEDIA_SNAPSHOT_FAILED','MEDIA_SCHEMA_UNSUPPORTED','OTHER'].map(mediaFailure)).size,5);
});
test('schema metadata is cached only within the same file and WAL generation',async()=>{
 let generation='a',queries=0;const db=new WeChatMediaDB('fixture',{stamp:async()=>generation,open:async()=>({query:async()=>{queries++;return[]},cleanup:async()=>{}})});
 const schema="SELECT name FROM sqlite_master WHERE type='table'";
 await Promise.all(Array.from({length:10},()=>db.query('/synthetic','key','hardlink/hardlink.db',schema)));assert.equal(queries,1);
 generation='b';await db.query('/synthetic','key','hardlink/hardlink.db',schema);assert.equal(queries,2);await db.close();
});
test('real SQLite v3 and v4 SQL resolves exact media identities, excludes unrelated prefixes',async()=>{
 const {DatabaseSync}=require('node:sqlite');
 for(const version of [3,4]){const sqlite=new DatabaseSync(':memory:');const hash='a'.repeat(32);sqlite.exec(`CREATE TABLE dir2id(username TEXT); INSERT INTO dir2id VALUES('2023-11'); CREATE TABLE video_hardlink_info_v${version}(md5 TEXT,file_name TEXT,dir1 INTEGER,dir2 INTEGER); INSERT INTO video_hardlink_info_v${version} VALUES('${hash}','exact.mp4',1,NULL),('${'b'.repeat(32)}','${hash}_unrelated.mp4',1,NULL)`);const db=new WeChatMediaDB('fixture');db.query=async(_r,_s,_p,sql)=>sqlite.prepare(sql).all();try{const result=await db.locateDetailed('/synthetic','key',{kind:43,text:`<msg><videomsg md5="${hash}"/></msg>`,chat:'synthetic',ts:1700000000});assert.deepEqual(result.links.map(x=>x.file_name),['exact.mp4'])}finally{sqlite.close()}}
});
