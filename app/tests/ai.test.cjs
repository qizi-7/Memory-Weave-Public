const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');const {Store}=require('../electron/store.cjs');const {AI,jsonRequest,cosine}=require('../electron/ai.cjs');
test('RAG pipeline persists real references and invalidates edited sources',async()=>{
 const server=http.createServer(async(req,res)=>{let s='';for await(const b of req)s+=b;const payload=s?JSON.parse(s):null;res.setHeader('Content-Type','application/json');if(req.url==='/api/tags')res.end(JSON.stringify({models:[{name:'embeddinggemma:latest',digest:'fixture-digest'}]}));else if(req.url==='/api/embed')res.end(JSON.stringify({embeddings:payload.input.map((t,i)=>[1,i+1,1])}));else res.end(JSON.stringify({done:true,message:{content:JSON.stringify({answer:'测试回答',citations:[1]})}}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const store=new Store(':memory:');const ai=new AI(store,'http://127.0.0.1:'+server.address().port);
 try{store.importData({version:1,account:{id:'a',name:'隔离测试'},contacts:[{id:'peer',name:'测试'}],messages:[{id:'1',chat:'peer',sender:'peer',timestamp:1700000000,text:'项目周五完成',kind:'text',outgoing:false}]});assert.equal((await ai.index('a')).indexed,1);const r=await ai.ask({account:'a',query:'什么时候完成'});assert.equal(r.sources[0].messages[0].id,'1');assert.match(r.answer,/\[1\]/);const m=store.messages({account:'a',chat:'peer'})[0];store.edit({account:'a',rowid:m.rowid,text:'已改为周一',note:'',ts:m.ts,hidden:false});await assert.rejects(ai.search({account:'a',query:'完成'}),/失效/);await ai.index('a');store.edit({account:'a',rowid:m.rowid,text:'已改为周一',note:'',ts:m.ts,hidden:true});await assert.rejects(ai.search({account:'a',query:'完成'}),/失效/);await assert.rejects(jsonRequest('https://example.com','/api/chat'),/只允许/);assert.throws(()=>cosine([1,2],[1]));}finally{store.close();await new Promise(r=>server.close(r));}
});
test('full-body deadline covers slow responses',async()=>{const server=http.createServer((_q,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.write('{');});await new Promise(r=>server.listen(0,'127.0.0.1',r));try{await assert.rejects(jsonRequest('http://127.0.0.1:'+server.address().port,'/slow',undefined,50),/超时/);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}});

test('independent chunks keep message references across size, time and conversation boundaries',()=>{
 const {normalizeKnowledgeMessage,chunkConversation}=require('../electron/knowledge-text.cjs');
 const input=(id,text,time=0,chat='peer')=>normalizeKnowledgeMessage({
  accountId:'a',conversationId:chat,messageId:String(id),createTime:time,senderName:'测试甲',text
 });
 const media=normalizeKnowledgeMessage({kind:'image',text:'<msg><img aeskey="fixture-media-value"/></msg>',note:'复核样本'});
 assert.equal(media.body,'[图片]\n备注：复核样本');
 const body='😀'.repeat(80)+'结尾';
 const messages=[input(1,'先发'),input(2,'同秒'),input(3,'间隔后',200),input(4,body,200),input(5,'另一会话',200,'other')];
 const opts={version:'test',maxGapMs:100,maxMessages:2,maxCharacters:30};
 const chunks=chunkConversation(messages,opts);
 assert.deepEqual(chunks,chunkConversation(messages,opts));
 assert.equal(new Set(chunks.map(c=>c.chunkId)).size,chunks.length);
 assert.deepEqual(chunks[0].messageIds,['1','2']);
 assert.deepEqual(chunks[1].messageIds,['3']);
 assert.equal(chunks.at(-1).conversationId,'other');
 assert.ok(chunks.every(c=>c.text.length<=30&&c.messageIds.length<=2&&c.text.isWellFormed()));
 const pieces=chunks.filter(c=>c.messageIds.includes('4'));
 assert.equal(pieces.map(c=>c.text).join(''),'测试甲: '+body);
 const single=chunkConversation(messages.slice(0,2),{...opts,maxMessages:1});
 assert.deepEqual(single.map(c=>c.messageIds),[['1'],['2']]);
});

test('rebuilding an existing complete index keeps it on failure and atomically swaps chunks on success',async()=>{
 const store=new Store(':memory:');
 const ai=new AI(store);
 try{
  store.importData({version:1,account:{id:'a',name:'Synthetic'},contacts:[{id:'peer',name:'Test'}],
   messages:[{id:'source',chat:'peer',sender:'peer',timestamp:10,text:'可核对的原文',kind:'text',outgoing:false}]});
  const revision=ai.revision('a'),model='synthetic-model';
  const {rowid}=store.db.prepare('SELECT rowid FROM messages').get();
  store.db.prepare('INSERT INTO knowledge_chunks VALUES(?,?,?,?,?,?,?,?)').run('a','legacy',model,revision,'peer','已有索引',JSON.stringify([rowid]),'[1,1]');
  store.db.prepare('INSERT INTO knowledge_manifests VALUES(?,?,?,1)').run('a',model,revision);
  ai.modelKey=async()=>model;
  ai.embed=async texts=>texts.map(()=>[1,1]);
  assert.equal((await ai.search({account:'a',query:'测试'}))[0].text,'已有索引');
  ai.embed=async()=>{throw Error('fixture failure')};
  await assert.rejects(ai.index('a'),/fixture failure/);
  assert.equal(store.db.prepare('SELECT id FROM knowledge_chunks').get().id,'legacy');
  assert.equal(store.db.prepare('SELECT complete FROM knowledge_manifests').get().complete,1);
  ai.embed=async texts=>texts.map(()=>[1,1]);
  assert.equal((await ai.index('a')).indexed,1);
  const results=await ai.search({account:'a',query:'测试'});
  assert.equal(results.length,1);
  assert.equal(results[0].messages[0].id,'source');
  assert.match(results[0].text,/可核对的原文/);
  assert.equal(store.db.prepare('SELECT count(*) n FROM knowledge_chunks').get().n,1);
 }finally{store.close()}
});
