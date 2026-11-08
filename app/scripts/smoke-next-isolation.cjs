// Real ARM64 Electron processes, exclusively synthetic temporary profiles.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),{once}=require('node:events');const {DatabaseSync}=require('node:sqlite');
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'mw-next-coexist-'))),app=path.resolve(__dirname,'..');
const delay=ms=>new Promise(r=>setTimeout(r,ms));const children=[];
async function wait(fn,label){for(let n=0;n<300;n++){const value=await fn();if(value)return value;await delay(50)}throw Error(label)}
async function launch(executable,profile,legacy=false){
 fs.mkdirSync(profile,{recursive:true});const child=spawn(executable||require('electron'),[...(executable?[]:[app]),'--validation-user-data='+profile,'--remote-debugging-port=0','--remote-debugging-address=127.0.0.1'],{stdio:['ignore','ignore','pipe']});children.push(child);let err='';child.stderr.on('data',d=>err=(err+d).slice(-12000));
 const port=await wait(()=>{if(child.exitCode!==null)throw Error('isolated app exited before window');return err.match(/DevTools listening on ws:\/\/127.0.0.1:(\d+)/)?.[1]},'DevTools');
 const target=await wait(async()=>{const list=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();return list.find(x=>x.type==='page'&&x.url.endsWith('/dist/index.html'))},'window');
 const ws=new WebSocket(target.webSocketDebuggerUrl);await once(ws,'open');let id=0;
 const evaluate=expression=>new Promise((resolve,reject)=>{const next=++id,t=setTimeout(()=>reject(Error('CDP evaluation timeout')),10000);const handler=({data})=>{const r=JSON.parse(data);if(r.id!==next)return;ws.removeEventListener('message',handler);clearTimeout(t);r.error||r.result.exceptionDetails?reject(Error('isolated renderer failed: '+expression+' '+(r.result?.exceptionDetails?.exception?.description||''))):resolve(r.result.result.value)};ws.addEventListener('message',handler);ws.send(JSON.stringify({id:next,method:'Runtime.evaluate',params:{expression:`(async()=>(${expression}))()`,returnByValue:true,awaitPromise:true}}))});
 await wait(()=>evaluate('!!window.archive'),'preload');return {child,ws,evaluate,profile};
}
async function stop(instance){instance.ws.close();instance.child.kill('SIGTERM');await once(instance.child,'exit')}
(async()=>{
 // Legacy process is an existing packaged executable, but its profile is synthetic and empty.
 const legacyExecutable=process.env.MW_LEGACY_EXECUTABLE;if(!legacyExecutable)throw Error('Explicit legacy executable required');
 const legacy=await launch(legacyExecutable,path.join(root,'old'),true);
 const next=await launch(process.env.MW_PACKAGED_EXECUTABLE,path.join(root,'next'));
 assert.equal(await legacy.evaluate('(await window.archive.accounts()).length'),0);
 assert.equal(await next.evaluate('(await window.archive.accounts()).length'),0);
 const document={version:1,account:{id:'fixture',name:'Synthetic'},contacts:[{id:'peer',name:'Synthetic'}],messages:[{id:'m1',chat:'peer',sender:'peer',timestamp:1700000000,kind:'text',text:'synthetic only',outgoing:false}]};
 fs.writeFileSync(path.join(next.profile,'synthetic-archive.json'),JSON.stringify(document));await next.evaluate('window.archive.validationImport()');
 const messages=await next.evaluate("window.archive.messages({account:'fixture',chat:'peer'})");assert.equal(messages.length,1);const rowid=messages[0].rowid;
 await next.evaluate(`window.archive.edit(${JSON.stringify({account:'fixture',rowid,text:'edited synthetic',note:'memo',hidden:false,ts:1700000000})})`);
 await next.evaluate(`window.archive.saveFavorite(${JSON.stringify({account:'fixture',rowid,saved:true})})`);
 assert.equal(await legacy.evaluate('(await window.archive.accounts()).length'),0);assert.equal(await next.evaluate('document.title'),'Memory Weave Next');
 await stop(next);const restarted=await launch(process.env.MW_PACKAGED_EXECUTABLE,next.profile);
 assert.equal(await restarted.evaluate("(await window.archive.messages({account:'fixture',chat:'peer'}))[0].displayContent"),'edited synthetic');assert.equal(await restarted.evaluate("(await window.archive.favorites({account:'fixture'})).items.length"),1);
 assert.equal(await restarted.evaluate("window.archive.autoSyncStatus().then(()=>false,e=>e.message.includes('验证模式禁止'))"),true);
 assert.equal(fs.existsSync(path.join(next.profile,'source-authorizations.enc')),false);assert.equal(fs.existsSync(path.join(next.profile,'wechat-keys')),false);
 await stop(restarted);await stop(legacy);
 for(const [name,count] of [['old',0],['next',1]]){const db=new DatabaseSync(path.join(root,name,'workspace.sqlite'),{readOnly:true});assert.equal(db.prepare('SELECT count(*) n FROM messages').get().n,count);assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');db.close()}
 console.log(JSON.stringify({arch:process.arch,electron:require('electron/package.json').version,coexistence:true,initialEmpty:true,writeViaIPC:true,favoriteViaIPC:true,editViaIPC:true,restartRetains:true,legacyUntouched:true,noAuthorizedAccounts:true,integrity:'ok',fixture:'synthetic-only'}));
})().catch(e=>{console.error(e.stack);process.exitCode=1}).finally(async()=>{for(const child of children)if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await Promise.race([once(child,'exit'),delay(3000)])}if(children.every(c=>c.exitCode!==null||c.signalCode!==null))fs.rmSync(root,{recursive:true,force:true})});
