// Launch a real Electron window with only a temporary synthetic archive.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn,execFileSync}=require('node:child_process'),{once}=require('node:events'),{performance}=require('node:perf_hooks');
const {Store}=require('../electron/store.cjs');
const app=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'mw-electron-'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(fn,label){const end=performance.now()+12000;let last;while(performance.now()<end){try{const r=await fn();if(r)return r}catch(e){last=e}await delay(40)}throw Error(label+(last?' ('+last.message+')':''))}
(async()=>{
 const store=new Store(path.join(temp,'workspace.sqlite'));
 const testMedia=process.env.MW_SYNTHETIC_MEDIA==='1';
 const tempReal=fs.realpathSync(temp),root=path.join(tempReal,'synthetic-media','xwechat_files','wxid_fixture');
 const messageFile=path.join(root,'db_storage/message/message_0.db');
 const syntheticTable='Msg_'+require('node:crypto').createHash('md5').update('peer').digest('hex');
 const captureDir=process.env.MW_LAYOUT_EVIDENCE;
 const account=testMedia?require('../electron/message-media.cjs').accountFor(root):'wechat:'+'a'.repeat(64);
 if(testMedia){
  const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/nL8AAAAASUVORK5CYII=','base64');
  const crypto=require('node:crypto'),hash=crypto.createHash('md5').update('peer').digest('hex'),key='a'.repeat(32),asset='b'.repeat(32);
  const month=new Date(1700000500*1000),part=month.getFullYear()+'-'+String(month.getMonth()+1).padStart(2,'0');
  const dirs={img:path.join(root,'msg','attach',hash,part,'Img'),video:path.join(root,'msg','video',part)};
  const make=(relative,sql,secret='ab'.repeat(32))=>{
   const filename=path.join(root,'db_storage',relative);fs.mkdirSync(path.dirname(filename),{recursive:true});
   execFileSync(path.resolve(app,'native/.build/encrypted-fixture'),[filename,'sql'],{input:secret+'\n'+sql});
  };
  make('head_image/head_image.db',`CREATE TABLE head_image(username TEXT,image_buffer BLOB); INSERT INTO head_image VALUES('peer',X'${image.toString('hex')}');`);
  make('hardlink/hardlink.db',`CREATE TABLE dir2id(username TEXT);INSERT INTO dir2id VALUES('${hash}'),('${part}');
   CREATE TABLE image_hardlink_info_v4(md5 TEXT,file_name TEXT,dir1 INTEGER,dir2 INTEGER);
   INSERT INTO image_hardlink_info_v4 VALUES('${key}','${asset}.dat',1,2);
   CREATE TABLE video_hardlink_info_v4(md5 TEXT,file_name TEXT,dir1 INTEGER,dir2 INTEGER);`);
  const pcm=new Int16Array(8000);for(let i=0;i<pcm.length;i++)pcm[i]=Math.sin(i/6)*2000;
  const voice=await require('silk-wasm').encode(new Uint8Array(pcm.buffer),16000);
  make('message/media_0.db',`CREATE TABLE Name2Id(user_name TEXT);INSERT INTO Name2Id VALUES('peer');
   CREATE TABLE VoiceInfo(voice_data BLOB,chat_name_id INTEGER,create_time INTEGER,local_id INTEGER);
   INSERT INTO VoiceInfo VALUES(X'${Buffer.from(voice.data).toString('hex')}',1,1700000502,7);`);
  make('message/media_1.db','CREATE TABLE encrypted_other(x);','cd'.repeat(32));
  for(const dir of Object.values(dirs))fs.mkdirSync(dir,{recursive:true});
  const cache=path.join(tempReal,'synthetic-media','app_data/net/kvcomm');fs.mkdirSync(cache,{recursive:true});fs.writeFileSync(path.join(cache,'key_42_fixture.statistic'),'');
  const header=Buffer.alloc(15);Buffer.from([7,8,86,50,8,7]).copy(header);header.writeUInt32LE(image.length,6);
  const aes=crypto.createCipheriv('aes-128-ecb',Buffer.from(crypto.createHash('md5').update('42wxid_fixture').digest('hex').slice(0,16)),null);
  fs.writeFileSync(path.join(dirs.img,asset+'.dat'),Buffer.concat([header,aes.update(image),aes.final()]));
  const ffmpeg=process.env.MW_FFMPEG||'ffmpeg';
  const dbContact=path.join(root,'db_storage/contact/contact.db');fs.mkdirSync(path.dirname(dbContact),{recursive:true});
  const {DatabaseSync}=require('node:sqlite');
  const contacts=new DatabaseSync(dbContact);contacts.exec("CREATE TABLE contact(username,nick_name);INSERT INTO contact VALUES('peer','Alice')");contacts.close();
  for(const file of [messageFile,messageFile.replace('_0.db','_1.db')]){
   const source=new DatabaseSync(file);
   source.exec(`CREATE TABLE ${syntheticTable}(local_id INTEGER PRIMARY KEY,create_time INTEGER NOT NULL,message_content,local_type,is_send);
    INSERT INTO ${syntheticTable} VALUES(1,1700000400,'synthetic sync baseline',1,0)`);source.close();
  }
  for(const [format,hash] of [['gif','c'],['webp','d']]){
   const md5=hash.repeat(32),dir=path.join(root,'cache','2024-01','Emoticon',md5.slice(0,2));fs.mkdirSync(dir,{recursive:true});
   const result=path.join(dir,md5+'.'+format);
   execFileSync(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc=size=32x32:rate=2:duration=1','-pix_fmt',format==='webp'?'yuv420p':'rgb8',result]);
   const animation=fs.readFileSync(result);
   assert.equal(format==='webp'?animation.includes('ANIM'):animation.includes('NETSCAPE2.0'),true);
   fs.renameSync(result,path.join(dir,md5));
  }
  execFileSync(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','color=blue:s=32x32:r=2:d=105','-c:v','libx264','-pix_fmt','yuv420p',path.join(dirs.video,key+'.mp4')]);

  for(const [marker,encrypted] of [['f',false],['1',true]]){
   const md5=marker.repeat(32),dir=path.join(root,'cache','2024-01','Emoticon',md5.slice(0,2));fs.mkdirSync(dir,{recursive:true});
   fs.writeFileSync(path.join(dir,md5),encrypted?fs.readFileSync(path.join(dirs.img,asset+'.dat')):image);
  }
  store.db.exec('CREATE TABLE wechat_sources(account TEXT,message_id TEXT,db_relative TEXT,table_name TEXT,source_local_id TEXT,PRIMARY KEY(account,message_id))');
  store.db.prepare('INSERT INTO wechat_sources VALUES(?,?,?,?,?)').run(account,'live-voice','message/message_0.db','fixture','7');
 }
 store.importData({version:1,account:{id:account,name:'Synthetic'},contacts:[{id:'peer',name:'Alice'},{id:'silent',name:'Bob'}],messages:[
  {id:'m1',chat:'peer',sender:'peer',timestamp:1700000000,kind:'text',text:'Synthetic discussion',outgoing:false},
  {id:'m2',chat:'peer',sender:'peer',timestamp:1700000001,kind:'image',text:'<msg><img /></msg>',outgoing:false}
 ]});store.close();
 if(process.env.MW_SYNTHETIC_EMOJI){
  const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGL5z8AAAAAA//+FDQv1AAAABklEQVQDAAMRAQSnRfifAAAAAElFTkSuQmCC','base64');
  const hash=require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(path.join(temp,'authorized-text-emoji.json'),JSON.stringify({version:1,source:'synthetic-only',license:'synthetic fixture',assets:['[捂脸]','[呲牙]','[微笑]','[旺柴]'].map(name=>({name,mime:'image/png',base64:bytes.toString('base64'),sha256:hash}))}),{mode:0o600});
 }
 const packaged=process.env.MW_PACKAGED_EXECUTABLE;
 const launch=()=>spawn(packaged||require('electron'),[...(packaged?[]:[app]),'--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--validation-user-data='+temp,...(testMedia?['--validation-synthetic-media']:[])],{stdio:['ignore','ignore','pipe']});
 let child=launch();
 let stderr='';child.stderr.on('data',d=>{stderr=(stderr+d).slice(-8000)});
 let ws;
 try{
  const dev=await wait(()=>stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/)?.[1],'Electron DevTools not ready');
  const target=await wait(async()=>{const targets=await (await fetch('http://127.0.0.1:'+dev+'/json/list')).json();return targets.find(t=>t.type==='page'&&t.url.endsWith('/dist/index.html'))},'app window unavailable');
  ws=new WebSocket(target.webSocketDebuggerUrl);await once(ws,'open');
  let id=0;
  const evaluate=expression=>new Promise((resolve,reject)=>{
   const next=++id;const listener=({data})=>{const r=JSON.parse(data);if(r.id!==next)return;ws.removeEventListener('message',listener);clearTimeout(timer);r.error||r.result.exceptionDetails?reject(Error('renderer evaluation failed: '+(r.result?.exceptionDetails?.exception?.description||r.error?.message||expression.slice(0,70)))):resolve(r.result.result.value)};
   const timer=setTimeout(()=>{ws.removeEventListener('message',listener);reject(Error('renderer evaluation timeout'))},3000);
   ws.addEventListener('message',listener);ws.send(JSON.stringify({id:next,method:'Runtime.evaluate',params:{expression,returnByValue:true,awaitPromise:true}}));
  });
  const click=label=>evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}||b.title===${JSON.stringify(label)});b?.click();return !!b})()`);
  const contains=text=>evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`);
  const timings={};
  const page=async(label,text)=>{const start=performance.now();assert.equal(await click(label),true);await wait(()=>contains(text),label);timings[label]=Math.round(performance.now()-start)};
  const command=(method,params={})=>new Promise((resolve,reject)=>{
   const next=++id;const receive=({data})=>{const r=JSON.parse(data);if(r.id!==next)return;ws.removeEventListener('message',receive);clearTimeout(timer);r.error?reject(Error(r.error.message)):resolve(r.result)};
   const timer=setTimeout(()=>{ws.removeEventListener('message',receive);reject(Error('CDP timeout: '+method))},5000);
   ws.addEventListener('message',receive);ws.send(JSON.stringify({id:next,method,params}));
  });
  const toggle=()=>evaluate("document.querySelector('.titlebar button[aria-expanded]').click();true");
  const geometry=collapsed=>evaluate(`(()=>{const shell=document.querySelector('.shell'),a=shell.firstElementChild.getBoundingClientRect(),m=shell.lastElementChild.getBoundingClientRect(),account=shell.querySelector('[aria-label="切换账号"]').getBoundingClientRect(),columns=getComputedStyle(shell).gridTemplateColumns.split(' ');return columns.length===2&&Math.abs(a.width-${collapsed?64:200})<1&&Math.abs(a.right-m.left)<1&&Math.abs(a.top-m.top)<1&&m.width>0&&m.height>0&&m.right<=innerWidth+1&&account.width>0&&account.right<=a.right+1})()`);
  const layout=async(collapsed,label)=>wait(()=>geometry(collapsed),label);
  const snap=async name=>{if(captureDir){fs.mkdirSync(captureDir,{recursive:true,mode:0o700});const {data}=await command('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(captureDir,name+'.png'),Buffer.from(data,'base64'),{mode:0o600})}};
  await wait(()=>contains('Alice'),'initial chat sessions');
  await page('通讯录','全部 2 人 · 有聊天 1 人');
  await page('打开聊天','Synthetic discussion');
  await wait(()=>contains('未定位本机微信账号目录'),'safe media outcome');
  assert.equal(await evaluate("(()=>{const b=[...document.querySelectorAll('.message button')].find(b=>b.textContent.trim()==='收藏');b?.click();return !!b})()"),true);
  await wait(()=>contains('已加入 Memory Weave 本地收藏。'),'favorite write');
  // Sidebar has a title for navigation; the message control is now 取消收藏.
  await page('收藏','定位原消息');
  assert.equal(await click('取消收藏'),true);
  await wait(()=>contains('没有符合条件的记录。'),'favorite removal');
  await page('通讯录','全部 2 人 · 有聊天 1 人');
  await page('打开聊天','Synthetic discussion');
  await wait(()=>evaluate("document.querySelectorAll('.message button').length>0"),'chat controls refreshed');
  assert.equal(await evaluate("[...document.querySelectorAll('.message button')].filter(b=>b.textContent.trim()==='取消收藏').length"),0,'chat must reflect favorite removed on another page');
  assert.equal(await evaluate("window.archive.messages({account:"+JSON.stringify(account)+",chat:'peer'}).then(rows=>rows.every(m=>!m.favorited))"),true);
  assert.equal(await evaluate("(()=>{const b=[...document.querySelectorAll('.message button')].find(b=>b.textContent.trim()==='收藏');b?.click();return !!b})()"),true);
  await wait(()=>evaluate("[...document.querySelectorAll('.message button')].some(b=>b.textContent.trim()==='取消收藏')"),'favorite saved again');
  await page('收藏','定位原消息');
  await page('定位原消息','Synthetic discussion');
  await page('聊天分析','24 小时活跃分布');
  await page('查看对应消息','定位原消息');
  await page('图片与视频','媒体索引');
  await wait(()=>contains('定位原消息'),'media metadata row');
  await page('数据诊断','消息 2 · 联系人 2 · 会话 1');
  assert.equal(await evaluate("window.archive.autoSyncNow('/synthetic-denied').then(()=>false,e=>e.message.includes('禁止访问真实微信'))"),true);
  const diag=await evaluate("window.archive.accounts().then(a=>window.archive.diagnostics(a[0].id))");
  assert.equal(diag.isolated,true);assert.equal(diag.sourceAvailable,false);
  assert.equal(await evaluate("window.archive.discoverWeChat().then(()=>false,e=>e.message.includes('禁止访问真实微信'))"),true);
  assert.equal(await evaluate("window.archive.connectWeChat({root:'/synthetic-denied'}).then(()=>false,e=>e.message.includes('禁止访问真实微信'))"),true);
  // Keep the same DOM and conversation open while a separate archive worker write commits.
  await page('聊天','Alice');
  assert.equal(await evaluate("(()=>{const b=document.querySelector('.contact');b?.click();return !!b})()"),true);
  await wait(()=>contains('Synthetic discussion'),'open current chat at latest');
  const live=[];
  for(let i=0;i<20;i++){
   const text='Synthetic live update '+String(i).padStart(2,'0')+' complete'+(i===19?'[捂脸][呲牙][微笑][旺柴]中文[项目名称][文件名]':'');
   const visibleText=text;
   fs.writeFileSync(path.join(temp,'synthetic-archive.json'),JSON.stringify({version:1,account:{id:account,name:'Synthetic'},contacts:[{id:'peer',name:'Alice'}],messages:[{id:'live-'+i,chat:'peer',sender:'peer',timestamp:1700000002+i,kind:'text',text,outgoing:false}]}),{mode:0o600});
   await evaluate(`(()=>{const list=document.querySelector('.messages');window.liveList=list;window.liveEvent=0;window.liveStop=window.archive.onMessagesCommitted(event=>{if(event.chats.includes('peer')){window.liveEvent=performance.now();window.liveCommittedAt=event.committedAt}});window.livePaint=0;window.liveObserver=new MutationObserver(()=>{if(!window.livePaint&&(()=>{const copy=list.cloneNode(true);for(const item of copy.querySelectorAll('[data-wechat-shortcode]'))item.replaceWith(document.createTextNode(item.dataset.wechatShortcode));return copy.textContent})().includes(${JSON.stringify(visibleText)})){window.livePaint=performance.now();window.livePaintAt=Date.now()}});window.liveObserver.observe(list,{subtree:true,childList:true});return true})()`);
   const start=performance.now();
   assert.equal((await evaluate('window.archive.validationImport()')).added,1);
   await wait(()=>evaluate(`!!window.livePaint&&window.liveList===document.querySelector('.messages')&&document.querySelector('.contact.selected .contact-preview').textContent.includes(${JSON.stringify(text)})`),'same open chat and session preview update').catch(async e=>{throw Error(e.message+' '+JSON.stringify(await evaluate("({event:window.liveEvent,paint:window.livePaint,dom:window.liveList===document.querySelector('.messages'),preview:document.querySelector('.contact.selected .contact-preview')?.textContent,messages:document.querySelector('.messages')?.children.length})")))});
   const t=await evaluate('(()=>{window.liveStop();window.liveObserver.disconnect();return {event:window.livePaint-window.liveEvent,commit:window.livePaintAt-window.liveCommittedAt}})()');
   assert.ok(t.event>=0&&t.commit>=0);live.push({startToVisible:performance.now()-start,eventToDOM:t.event,commitToDOM:t.commit});
  }
  const emojiText='[捂脸][呲牙][微笑][旺柴]中文[项目名称][文件名]';

  await wait(()=>evaluate("document.querySelectorAll('[data-wechat-shortcode]').length>=4"),'verified shortcode vocabulary preserves exact text');
  if(!process.env.MW_SYNTHETIC_EMOJI){
  assert.equal(await evaluate("document.querySelector('[data-wechat-shortcode=\"[捂脸]\"]')?.textContent"),'[捂脸]');
  assert.equal(await contains('[旺柴]中文[项目名称][文件名]'),true);
  assert.equal(await evaluate("document.querySelector('[data-wechat-shortcode]').parentElement.textContent"),'Synthetic live update 19 complete'+emojiText);
  assert.equal(await evaluate("document.querySelectorAll('[data-wechat-shortcode] img,[data-wechat-shortcode][role=img]').length"),0);
  }else{
   await wait(()=>evaluate("[...document.querySelectorAll('[data-wechat-shortcode] img')].filter(i=>i.complete&&i.naturalWidth>0).length===4"),'local emoji resources decoded');
   const copied=await evaluate(`(()=>{const target=document.querySelector('[data-wechat-shortcode]').parentElement,range=document.createRange();range.selectNodeContents(target);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);const data=new DataTransfer();document.dispatchEvent(new ClipboardEvent('copy',{clipboardData:data,bubbles:true,cancelable:true}));selection.removeAllRanges();return data.getData('text/plain')})()`);
   assert.equal(copied,'Synthetic live update 19 complete'+emojiText);
   await evaluate("(()=>{document.querySelector('[data-wechat-shortcode] img').dispatchEvent(new Event('error'));return true})()");
   await wait(()=>evaluate("document.querySelector('[data-wechat-shortcode]').textContent==='[捂脸]'"),'failed local resource preserves original text');
   console.log(JSON.stringify({localEmojiPack:{decoded:4,copyPreserved:true,failureFallback:true,syntheticOnly:true}}));
  }
  if(testMedia){
   assert.equal(await evaluate('window.archive.validationMedia(false)'),true);
   const input={version:1,account:{id:account,name:'Synthetic'},contacts:[{id:'peer',name:'Alice'}],messages:[
    {id:'live-image',chat:'peer',sender:'peer',timestamp:1700000500,kind:'image',text:'<msg><img md5="'+ 'a'.repeat(32)+'"/></msg>',outgoing:false},
    {id:'live-video',chat:'peer',sender:'peer',timestamp:1700000501,kind:'video',text:'<msg><videomsg md5="'+ 'a'.repeat(32)+'" playlength="105"/></msg>',outgoing:false},
    {id:'live-voice',chat:'peer',sender:'peer',timestamp:1700000502,kind:'voice',text:'<msg><voicemsg voicelength="500"/></msg>',outgoing:false}
   ]};
   fs.writeFileSync(path.join(temp,'synthetic-archive.json'),JSON.stringify(input));
   assert.equal((await evaluate('window.archive.validationImport()')).added,3);
   const bubble=(id,query)=>`(()=>{const rows=[...document.querySelectorAll('.message')];const m=rows.at(${id});return m?.querySelector(${JSON.stringify(query==='.bubble'?query:'.bubble '+query)})})()`;
   await wait(()=>evaluate("document.querySelectorAll('.message').length===25"),'media rows committed');
   await evaluate(bubble(-3,'.bubble')+"?.scrollIntoView({block:'center'}) ?? true");
   await wait(()=>evaluate(bubble(-3,'.message-unavailable')+"?.textContent.includes('缺少媒体数据库密钥')"),'image absent before metadata permission').catch(async e=>{throw Error(e.message+' '+JSON.stringify(await evaluate("Array.from(document.querySelectorAll('.message')).slice(-4).map(m=>m.innerText)")))});
   const checks=await evaluate('window.archive.validationMedia(true)');
   assert.equal(checks.available,true,JSON.stringify(checks));assert.deepEqual(checks.results.map(r=>r.state),['verified','verified','verified','mismatch']);
   await wait(()=>evaluate("document.querySelector('.contact.selected .avatar img')?.naturalWidth>0"),'avatar retries on media authorization');
   await wait(()=>evaluate(bubble(-3,'img')+'?.naturalWidth>0'),'V2 image retries on media authorization');
   const savedMediaCheck=await evaluate("window.archive.validationMedia('saved')");assert.equal(savedMediaCheck.available,true,JSON.stringify({initial:checks,saved:savedMediaCheck}));
   await wait(()=>evaluate('(()=>{const v='+bubble(-2,'video.message-frame')+';return v?.readyState>=2&&v.paused&&v.duration===105})()'),'105-second video decoded without thumbnail');
   assert.equal(await contains('1:45'),true);
   for(const [index,tag] of [[-2,'video'],[-1,'audio']]){
    assert.equal(await evaluate(bubble(index,'.message-play')+'?.click() ?? true'),true);
    await wait(()=>evaluate(bubble(index,tag)+'?.readyState>=2'),'playable '+tag);
   }
   const stickerPath=(key)=>path.join(root,'cache','2024-01','Emoticon',key.repeat(2),key.repeat(32));
   const lateTmp=stickerPath('9'),wxgfPath=stickerPath('7'),seedImage=stickerPath('f');
   for(const filename of [lateTmp,wxgfPath])fs.mkdirSync(path.dirname(filename),{recursive:true});
   fs.writeFileSync(lateTmp,'');
   const clip=execFileSync(process.env.MW_FFMPEG||'ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=s=32x32:r=5:d=1','-c:v','libx265','-x265-params','log-level=error:pools=none','-f','hevc','pipe:1']);
   const wxgf=Buffer.alloc(20);wxgf.write('wxgf');wxgf[4]=20;
   const k=require('node:crypto').createHash('md5').update('42wxid_fixtureEMOTICON').digest(),aes=require('node:crypto').createCipheriv('aes-128-cbc',k,k);
   fs.writeFileSync(wxgfPath,Buffer.concat([aes.update(Buffer.concat([wxgf,clip])),aes.final()]));
   const extras=[['gif','c'],['webp','d'],['png','f'],['encrypted','1'],['wxgf','7'],['temporary','9'],['network','e']].map(([type,hash],i)=>({id:'sticker-'+type,chat:'peer',sender:'peer',timestamp:1700000600+i,kind:'system',text:'<msg><emoji md5="'+hash.repeat(32)+'" cdnurl="https://invalid.example/sticker"/></msg>',outgoing:false}));
   fs.writeFileSync(path.join(temp,'synthetic-archive.json'),JSON.stringify({...input,messages:extras}));
   assert.equal((await evaluate('window.archive.validationImport()')).added,7);
   await wait(()=>evaluate([-7,-6,-5,-4,-3].map(i=>bubble(i,'img')+'?.naturalWidth>0').join(' && ')),'GIF, WebP, PNG and encrypted stickers render');
   await wait(()=>evaluate('!!'+bubble(-3,'select[aria-label="本条动画延时倍数"]')),'WXGF calibration control after load');
   await evaluate(bubble(-3,'select[aria-label="本条动画延时倍数"]')+".value='2';"+bubble(-3,'select[aria-label="本条动画延时倍数"]')+".dispatchEvent(new Event('change',{bubbles:true}));true");
   await wait(()=>evaluate(bubble(-3,'img')+"?.src.includes('timing=2') && "+bubble(-3,'img')+"?.complete && "+bubble(-3,'img')+"?.naturalWidth>0"),'per-sticker calibration preserves decoded image').catch(async error=>{throw Error(error.message+' '+JSON.stringify(await evaluate(bubble(-3,'.bubble')+" && ({text:"+bubble(-3,'.bubble')+".textContent,img:"+bubble(-3,'img')+"?.getAttribute('src'),select:"+bubble(-3,'select')+"?.value})")))});
   await wait(()=>contains('本机没有表情缓存；该消息有网络资源，本应用未访问'),'remote-only sticker classified');
   await wait(()=>evaluate(bubble(-2,'.media-retry')+"?.textContent==='重试'"),'temporary open failure exposes retry');
   fs.copyFileSync(seedImage,lateTmp);
   await evaluate(bubble(-2,'.media-retry')+'?.click() ?? true');
   await wait(()=>evaluate(bubble(-2,'img')+'?.naturalWidth>0'),'temporary media retry decodes');
   await evaluate("window.stabilityChat=document.querySelector('.messages');true");
   const lateHash='e'.repeat(32),lateDir=path.join(root,'cache','2024-01','Emoticon','ee');
   fs.mkdirSync(lateDir,{recursive:true});
   fs.copyFileSync(path.join(root,'cache','2024-01','Emoticon','ff','f'.repeat(32)),path.join(lateDir,lateHash));
   await evaluate(bubble(-1,'.media-recovery summary')+'?.click() ?? true');
   await evaluate(bubble(-1,'.media-retry')+'?.click() ?? true');
   await wait(()=>evaluate(bubble(-1,'img')+'?.naturalWidth>0 && window.stabilityChat===document.querySelector(".messages")'),'late local sticker reload in current chat');
   assert.equal(await evaluate("[...document.querySelectorAll('.bubble')].slice(-10).every(b=>!b.querySelector('.media-retry'))"),true);
   await evaluate("window.layoutMedia=document.querySelector('video[controls]');window.layoutChat=document.querySelector('.messages');document.querySelector('[aria-label=筛选会话]').value='';true");
   await toggle();await layout(true,'loaded media layout remains visible');
   assert.equal(await evaluate("window.layoutMedia===document.querySelector('video[controls]')&&window.layoutChat===document.querySelector('.messages')"),true);
   await snap('media-collapsed');await toggle();await layout(false,'media expands without remount');
   const missingHash='8'.repeat(32);
   fs.writeFileSync(path.join(temp,'synthetic-archive.json'),JSON.stringify({...input,messages:[{id:'missing-video-recovery',chat:'peer',sender:'peer',timestamp:1700000650,kind:'video',text:'<msg><videomsg md5="'+missingHash+'" playlength="105"/></msg>',outgoing:false}]}));
   assert.equal((await evaluate('window.archive.validationImport()')).added,1);
   await wait(()=>evaluate('!!'+bubble(-1,'.message-play')),'new video card');
   await evaluate(bubble(-1,'.message-play')+'?.click() ?? true');
   await wait(()=>contains('未找到媒体索引'),'missing index distinguished from missing file');
   assert.equal(await evaluate(bubble(-1,'.message-media-error details')+'?.open'),false);
   assert.equal(await evaluate(`(()=>{const m=[...document.querySelectorAll('.message')].at(-1);const h=m.querySelector('.message-media-heading').getBoundingClientRect(),b=m.querySelector('.message-play').getBoundingClientRect(),e=m.querySelector('.message-media-error').getBoundingClientRect();return h.bottom<=b.top&&b.bottom<=e.top&&getComputedStyle(m.querySelector('.message-play')).position==='static'})()`),true);
   const month=new Date(1700000650*1000),part=month.getFullYear()+'-'+String(month.getMonth()+1).padStart(2,'0');
   fs.copyFileSync(path.join(root,'msg/video',part,'a'.repeat(32)+'.mp4'),path.join(root,'msg/video',part,missingHash+'.mp4'));
   await evaluate(bubble(-1,'.message-media-error summary')+'?.click() ?? true');
   await evaluate(bubble(-1,'.message-media-error .media-retry')+'?.click() ?? true');
   await wait(()=>evaluate(bubble(-1,'video[controls]')+'?.readyState>=2'),'late local video recovers without a hardlink row');
   assert.equal((await evaluate('window.archive.validationSync()')).added,2);
   assert.equal(await evaluate("!!document.querySelector('.sync-card')"),false);
   assert.equal(await click('微信同步状态'),true);
   await wait(()=>evaluate("!!document.querySelector('.sync-card')"),'manual sync details');
   assert.equal(await click('微信同步状态'),true);
   const {DatabaseSync}=require('node:sqlite');
   const healthy=new DatabaseSync(messageFile);healthy.exec(`INSERT INTO ${syntheticTable} VALUES(2,1700000700,'synthetic partial healthy append',1,0)`);healthy.close();
   const failed=new DatabaseSync(messageFile.replace('_0.db','_1.db'));failed.exec(`UPDATE ${syntheticTable} SET message_content='changed source anchor'`);failed.close();
   assert.equal(await click('跟踪下一条更新'),true);
   await wait(()=>contains('我已在微信看到测试消息'),'opt-in trace panel');
   assert.equal(await click('我已在微信看到测试消息'),true);
   await toggle();await layout(true,'collapsed during sync');
   const partial=await evaluate('window.archive.validationSync()');assert.equal(partial.added,1);assert.equal(partial.failedTables,1);
   await wait(()=>evaluate("window.stabilityChat===document.querySelector('.messages')&&window.stabilityChat.textContent.includes('synthetic partial healthy append')"),'partial worker commit updates current chat');
   await evaluate("document.querySelector('.message:last-child').scrollIntoView({block:'center'});true");
   await wait(()=>evaluate("document.querySelector('.trace-strip')?.innerText.match(/T[0-6] \\d{2}:/g)?.length===7"),'all seven opt-in trace points reported').catch(async e=>{throw Error(e.message+' '+await evaluate("document.querySelector('.trace-strip')?.innerText"))});
   assert.equal(await evaluate("document.querySelector('[title=微信同步状态]').textContent.includes('部分成功')"),true);
   const latest=await evaluate("document.querySelector('.message:last-child').id");
   assert.equal(await click('通讯录'),true);await wait(()=>contains('打开聊天'),'directory ready');await page('打开聊天','synthetic partial healthy append');
   assert.equal(await evaluate("document.querySelector('.message:last-child').id"),latest);
   await toggle();await layout(false,'expanded after sync');
   assert.equal(await evaluate("!!document.querySelector('.sync-card')"),false);
   assert.equal(await click('微信同步状态'),true);
   await wait(()=>contains('SHARD_CHANGED'),'partial failure details still visible');
   ws.close();child.kill('SIGTERM');await once(child,'exit');
   stderr='';child=launch();child.stderr.on('data',d=>{stderr=(stderr+d).slice(-8000)});
   const restartedPort=await wait(()=>stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/)?.[1],'isolated app restarted');
   const restarted=await wait(async()=>{const list=await(await fetch('http://127.0.0.1:'+restartedPort+'/json/list')).json();return list.find(t=>t.type==='page'&&t.url.endsWith('/dist/index.html'))},'restarted page');
   ws=new WebSocket(restarted.webSocketDebuggerUrl);await once(ws,'open');
   await wait(()=>contains('Alice'),'restarted workspace');
   await wait(()=>evaluate("Array.from(document.querySelectorAll('img')).some(i=>i.complete&&i.naturalWidth>0&&i.src.includes('/avatar/'))"),'automatic saved-media avatar restoration');
   // No manual validationMedia('saved') call after restart.

   console.log(JSON.stringify({mediaFixture:{avatar:1,v2Image:1,videoFirstFrame:1,videoSeconds:105,videoPlayback:1,voicePlayback:1,mismatch:1,gif:1,webp:1,pngSticker:1,encryptedSticker:1,remoteOnly:1,savedVerificationAfterRestart:1},partialLiveSync:true,lateStickerReload:true,optInTracePoints:7,quietSync:true}));
  }
  for(const [label,width,height,theme,motion] of [['normal',1280,860,'light','no-preference'],['narrow',900,680,'dark','reduce'],['wide',1460,900,'dark','no-preference']]){
   await command('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false,screenWidth:width,screenHeight:height});
   await command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:motion},{name:'prefers-color-scheme',value:theme}]});
   const pages=['聊天','通讯录','收藏','图片与视频','聊天分析','数据诊断','AI 助手','设置','导出中心'];
   for(const name of pages){
    assert.equal(await click(name),true);
    await layout(false,label+' '+name+' expanded');
    await toggle();await layout(true,label+' '+name+' collapsed');
    if(name==='聊天'||name==='设置')await snap(label+'-'+(name==='聊天'?'chat':'settings')+'-collapsed');
    await toggle();await layout(false,label+' '+name+' restored');
   }
  }
  await click('聊天');
  await layout(false,'expanded control');
  await toggle();await layout(true,'baseline geometry control');
  await evaluate("const controlCss=document.createElement('style');controlCss.id='old-grid-control';controlCss.textContent='.shell.collapsed{grid-template-columns:64px!important}';document.head.append(controlCss);true");
  await wait(async()=>!(await geometry(true)),'old one-column layout reproducibly fails geometry');
  await evaluate("document.querySelector('#old-grid-control').remove();true");
  await layout(true,'restored two-column layout');
  await toggle();await layout(false,'ready to cycle');
  for(let n=0;n<20;n++){await toggle();await layout(true,'cycle collapse '+n);await toggle();await layout(false,'cycle expand '+n)}
  await snap('wide-expanded');
  console.log(JSON.stringify({layout:{viewports:3,pages:9,consecutiveCycles:20}}));
  const p=(key,q)=>[...live].map(r=>r[key]).sort((a,b)=>a-b)[Math.ceil(live.length*q)-1];
  console.log(JSON.stringify({liveSamples:live.length,importToVisibleMs:[.5,.95,.99].map(q=>p('startToVisible',q)),ipcToDomMs:[.5,.95,.99].map(q=>p('eventToDOM',q)),commitToDomMs:[.5,.95,.99].map(q=>p('commitToDOM',q)),sameChatDOM:true}));
  console.log(JSON.stringify({electron:require('electron/package.json').version,arch:process.arch,fixture:'synthetic-only',pages:timings,mediaSourceBlocked:true,discoveryBlocked:true,connectionBlocked:true,crossPageFavoriteConsistent:true},null,2));
 }finally{
  ws?.close();child.kill('SIGTERM');await Promise.race([once(child,'exit'),delay(2000)]);if(child.exitCode!==null||child.signalCode!==null)fs.rmSync(temp,{recursive:true,force:true});
 }
})().catch(e=>{console.error(e.stack);process.exitCode=1});
