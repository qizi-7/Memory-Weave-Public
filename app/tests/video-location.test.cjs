const {test}=require('node:test'),assert=require('node:assert/strict');
const {WeChatMediaDB}=require('../electron/wechat-media-db.cjs');
const {mediaResponse}=require('../electron/message-media.cjs');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const hash='a'.repeat(32),row={kind:43,text:`<msg><videomsg md5="${hash}" playlength="24"/></msg>`,chat:'synthetic',ts:1700000000};
test('video metadata and a verified but empty index are different outcomes; absent hash never guesses',async()=>{
 const db=new WeChatMediaDB('synthetic');let queries=[];db.query=async(_r,_s,_d,sql)=>{queries.push(sql);return sql.includes('sqlite_master')?[{name:'video_hardlink_info_v4'}]:sql.startsWith('PRAGMA')?['md5','file_name','dir1','dir2'].map(name=>({name})):[]};
 assert.equal((await db.locateDetailed('/synthetic','test',{...row,text:'<msg><videomsg playlength="24"/></msg>'},'play')).reason,'metadataMissing');assert.equal(queries.length,0);
 assert.equal((await db.locateDetailed('/synthetic','test',row,'play')).reason,'mediaIndexMissing');assert.equal(queries.length,4);assert.ok(queries.slice(2).every(q=>q.includes('LIMIT 32')));
 db.query=async()=>{throw Object.assign(Error('synthetic'),{code:'MEDIA_KEY_MISMATCH'})};await assert.rejects(db.locateDetailed('/synthetic','test',row,'play'),{code:'MEDIA_KEY_MISMATCH'});
});
test('indexed filenames remain exact; full video range, HEAD and direct local fallback work independently of index',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'mw-video-range-')));const date=new Date(row.ts*1000),month=date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0');
 const folder=path.join(root,'msg/video',month),url='mw-media://archive/'+'1'.repeat(64)+'/1/play';let status;
 const lookup=async()=>({root,row,metadataBlocked:'mediaIndexMissing',onOutcome:s=>status=s});
 try{assert.equal((await mediaResponse(new Request(url),lookup)).status,404);assert.equal(status,'mediaIndexMissing');await fs.mkdir(folder,{recursive:true});const data=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(100)]);await fs.writeFile(path.join(folder,hash+'.mp4'),data);
 const response=await mediaResponse(new Request(url,{headers:{range:'bytes=0-15'}}),lookup);assert.equal(response.status,206);assert.equal(response.headers.get('content-range'),`bytes 0-15/${data.length}`);assert.equal(status,'readable');assert.deepEqual(Buffer.from(await response.arrayBuffer()),data.subarray(0,16));
 const head=await mediaResponse(new Request(url,{method:'HEAD'}),lookup);assert.equal(head.status,200);assert.equal(head.headers.get('content-type'),'video/mp4');assert.equal((await head.arrayBuffer()).byteLength,0);
 assert.equal((await mediaResponse(new Request(url,{headers:{range:'bytes=9999-'}}),lookup)).status,416);
 }finally{await fs.rm(root,{recursive:true,force:true})}
});
