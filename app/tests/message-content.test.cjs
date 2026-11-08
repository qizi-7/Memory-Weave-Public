const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {createHash}=require('node:crypto');
const {Store}=require('../electron/store.cjs');
const {parseWeChatMessage,buildMessagePreview,publicMessage}=require('../electron/message-content.cjs');
const {mediaResponse}=require('../electron/message-media.cjs');

const hash='1234567890abcdef1234567890abcdef';
const template='<sysmsg type="sysmsgtemplate"><sysmsgtemplate><content_template><plain/><template><![CDATA["$adder$"加入群聊 $revoke$]]></template><link_list><link name="adder"><memberlist><member><nickname><![CDATA[测试昵称]]></nickname></member></memberlist></link><link name="revoke" hidden="1"><title>撤销</title></link></link_list></content_template></sysmsgtemplate></sysmsg>';
const image='<msg><img md5="'+hash+'" aeskey="dummyKey" cdnthumburl="dummyValue"/></msg>';
const messages=[
 ['text','测试消息 🧶','text','测试消息 🧶'],
 ['image',image,'image','[图片]'],
 ['video','<msg><videomsg playlength="8" length="10000"/></msg>','video','[视频]'],
 ['voice','<msg><voicemsg voicelength="1600" length="6672"/></msg>','voice','[语音]'],
 ['system','<msg><emoji md5="'+hash+'"/></msg>','sticker','[动画表情]'],
 ['link','<msg><appmsg><type>6</type><title>示例.pdf</title><appattach><totallen>2048</totallen></appattach></appmsg></msg>','file','[文件] 示例.pdf'],
 ['link','<msg><appmsg><type>57</type><refermsg><type>1</type><displayname>用户</displayname><content>示例原文</content></refermsg></appmsg></msg>','quote','[引用消息] 用户 · 示例原文'],
 ['link','<msg><appmsg><title><![CDATA[示例文章 & 标题]]></title><type>5</type></appmsg></msg>','share','[链接] 示例文章 & 标题'],
 ['link','<msg><appmsg><type>33</type><title>示例服务</title></appmsg></msg>','miniProgram','[小程序] 示例服务'],
 ['link','<msg><appmsg><type>2000</type><wcpayinfo><feedesc>¥1.00</feedesc></wcpayinfo></appmsg></msg>','transfer','[转账]'],
 ['system','<sysmsg type="revokemsg"><revokemsg><replacemsg>用户撤回了一条消息</replacemsg></revokemsg></sysmsg>','system','用户撤回了一条消息'],
 ['system',template,'system','"测试昵称"加入群聊'],
 ['system','<sysmsg type="unknown"><token>dummy</token></sysmsg>','system','[系统消息]']
];

test('archived shapes use the same safe display in chat, sessions and IPC',()=>{
 const store=new Store(':memory:');
 try {
  const account={id:'test',name:'测试账号'};
  const rows=messages.map(([kind,text],i)=>({id:String(i),chat:'chat'+i,sender:'匿名',timestamp:i+1,text,outgoing:false,kind}));
  store.importData({version:1,account,messages:rows,contacts:rows.map(row=>({id:row.chat,name:row.chat}))});
  const previews=new Map(store.sessions(account.id).map(row=>[row.id,row.preview]));
  for(const [i,[,raw,type,preview]] of messages.entries()){
   const chat='chat'+i;
   const row=store.messages({account:account.id,chat})[0];
   assert.equal(row.original,raw);
   const exposed=publicMessage(row);
   assert.equal(exposed.contentData.type,type);
   assert.equal(exposed.displayContent,preview);
   assert.equal(previews.get(chat),preview);
   assert.equal('original' in exposed,false);
   assert.equal('text' in exposed,false);
   assert.doesNotMatch(JSON.stringify(exposed),/dummyKey|dummyValue|<sysmsg|<appmsg|<msg>/);
  }
  const [row]=store.messages({account:account.id,chat:'chat1'});
  store.edit({account:account.id,rowid:row.rowid,text:null,ts:20,note:'本地备注',hidden:false});
  assert.equal(store.messages({account:account.id,chat:'chat1'})[0].contentData.type,'image');
  assert.equal(store.db.prepare('SELECT text FROM messages WHERE rowid=?').get(row.rowid).text,image);
 } finally {store.close();}
});
test('numeric types, XML envelopes and untrusted fallback never expose payload',()=>{
 assert.equal(parseWeChatMessage(image,'3').type,'image');
 assert.equal(parseWeChatMessage(image,3).hashes[0],hash);
 assert.equal(parseWeChatMessage(image,'1').type,'image');
 assert.equal(parseWeChatMessage(messages[2][1],43).duration,8);
 assert.equal(parseWeChatMessage(messages[3][1],34).duration,1.6);
 assert.equal(parseWeChatMessage('',34).type,'voice');
 assert.equal(parseWeChatMessage('someone:\n'+image,3).type,'image');
 assert.equal(buildMessagePreview(parseWeChatMessage('<msg><img aeskey="xx"',3)),'[图片]');
 for(const raw of ['<script>alert(1)</script>','{"encrypted":"value"}','AAaa10/'.repeat(40),
  '<!DOCTYPE msg [<!ENTITY e SYSTEM "file:///etc/passwd">]><msg>&e;</msg>']){
  assert.equal(buildMessagePreview(parseWeChatMessage(raw,1)),'[暂不支持的消息]');
 }
 for (const text of ['https://example.test/'+ 'a'.repeat(1000),'EnglishWord'.repeat(100)]) {
  assert.equal(parseWeChatMessage(text,1).type,'text');
  assert.ok(buildMessagePreview(parseWeChatMessage(text,1)).endsWith('…'));
 }
 const long=buildMessagePreview(parseWeChatMessage('文字😀\n'.repeat(200),1),24);
 assert.equal(Array.from(long).length,25);
 assert.doesNotMatch(long,/\n/);
});
test('media endpoint returns verified local image bytes and ranges, and rejects symlinks or missing files',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'mw-media-')));
 const chat='test-chat',ts=1700000000;
 const date=new Date(ts*1000),month=date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0');
 const imgDir=join(root,'msg','attach',createHash('md5').update(chat).digest('hex'),month,'Img');
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/L1sAAAAASUVORK5CYII=','base64');
 const url='mw-media://archive/'+'1'.repeat(64)+'/1/preview';
 const lookup=async()=>({root,row:{kind:'image',text:image,chat,ts}});
 try {
  await fs.mkdir(imgDir,{recursive:true});
  const file=join(imgDir,hash+'_t.dat');
  await fs.writeFile(file,png.map(v=>v^0x7f));
  const full=await mediaResponse(new Request(url),lookup);
  assert.equal(full.headers.get('content-type'),'image/png');
  assert.deepEqual(Buffer.from(await full.arrayBuffer()),png);
  const partial=await mediaResponse(new Request(url,{headers:{range:'bytes=2-9'}}),lookup);
  assert.equal(partial.status,206);
  assert.deepEqual(Buffer.from(await partial.arrayBuffer()),png.subarray(2,10));
  await fs.unlink(file);
  await fs.symlink('/etc/passwd',file);
  assert.equal((await mediaResponse(new Request(url),lookup)).status,404);
  assert.equal((await mediaResponse(new Request(url.replace('/preview','/play')),lookup)).status,404);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('twelve synthetic payload shapes keep preview and bubble meaning consistent',()=>{
 const samples=require('./fixtures/message-display.json');
 assert.equal(samples.length,12);
 for(const sample of samples){
  const parsed=parseWeChatMessage(sample.raw,sample.kind);
  assert.equal(parsed.type,sample.type,sample.category);
  assert.equal(parsed.reason,undefined,sample.category);
  assert.equal(buildMessagePreview(parsed),sample.preview,sample.category);
  assert.doesNotMatch(JSON.stringify({preview:sample.preview,content:parsed.text,title:parsed.title}),/<sysmsg|<img|<content_template|aeskey|cdnthumburl/i);
 }
});

test('V2 ciphertext requires a matching account cache code and preserves the image bytes',async()=>{
 const {mkdtemp,mkdir,writeFile,rm}=require('node:fs/promises');
 const {join}=require('node:path');
 const {tmpdir}=require('node:os');
 const {createHash,createCipheriv}=require('node:crypto');
 const {decryptV2}=require('../electron/wechat-image.cjs');
 const dir=await mkdtemp(join(tmpdir(),'weave-v2-'));
 const root=join(dir,'xwechat_files','wxid_fixture_1234');
 try{
  const kv=join(dir,'app_data','net','kvcomm');
  await mkdir(kv,{recursive:true});
  await writeFile(join(kv,'key_873_fixture.statistic'),'');
  const image=Buffer.from('89504e470d0a1a0a0000000049454e44ae426082','hex');
  const aesLength=11,tailLength=4;
  const header=Buffer.from([7,8,86,50,8,7,0,0,0,0,0,0,0,0,0]);
  header.writeUInt32LE(aesLength,6);header.writeUInt32LE(tailLength,10);
  const key=createHash('md5').update('873wxid_fixture').digest('hex').slice(0,16);
  const cipher=createCipheriv('aes-128-ecb',Buffer.from(key),null);
  const encrypted=Buffer.concat([header,cipher.update(image.subarray(0,aesLength)),cipher.final(),
   image.subarray(aesLength,-tailLength),image.subarray(-tailLength).map(byte=>byte^(873&255))]);
  const png=bytes=>bytes.subarray(0,8).equals(image.subarray(0,8));
  assert.deepEqual(await decryptV2(root,encrypted,png),image);
  assert.equal(await decryptV2(join(dir,'xwechat_files','wxid_other'),encrypted,png),null);
 }finally{await rm(dir,{recursive:true,force:true});}
});
