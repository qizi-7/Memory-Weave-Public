// Synthetic credentials only. A separate Electron process and profile for each phase.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
if(!process.versions.electron){
 const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'mw-safe-storage-')));
 try{
  for(const phase of ['save','restart']){
   const result=spawnSync(require('electron'),[__filename,temp,phase],{encoding:'utf8',timeout:45000,env:{...process.env,ELECTRON_RUN_AS_NODE:''}});
   if(result.status!==0)throw Error('Electron synthetic '+phase+' failed: '+(result.stdout||'').slice(-1000));
   console.log(result.stdout.trim());
  }
 }finally{fs.rmSync(temp,{recursive:true,force:true})}
}else{
 const {app,safeStorage}=require('electron'),assert=require('node:assert/strict');
 const [temp,phase]=process.argv.slice(2);app.setPath('userData',temp);
 app.whenReady().then(async()=>{
  assert.equal(safeStorage.isEncryptionAvailable(),true);
  const vault=require('../electron/wechat-vault.cjs'),{authorizations,AutoSync}=require('../electron/auto-sync.cjs'),{Store}=require('../electron/store.cjs'),{importWeChat}=require('../electron/wechat-adapter.cjs');
  const root=path.join(temp,'source'),source=path.join(root,'db_storage'),helper=path.resolve(__dirname,'../native/.build/wechat-reader'),key='ab'.repeat(32);
  if(phase==='save'){
   for(const kind of ['contact','message']){fs.mkdirSync(path.join(source,kind),{recursive:true});const r=spawnSync(path.resolve(__dirname,'../native/.build/encrypted-fixture'),[path.join(source,kind,kind==='contact'?'contact.db':'message_0.db'),kind],{input:key});assert.equal(r.status,0)}
  }
  const auth=authorizations(path.join(temp,'authorized.enc'),{available:vault.available,encrypt:s=>safeStorage.encryptString(s),decrypt:b=>safeStorage.decryptString(b)});
  const store=new Store(path.join(temp,'workspace.sqlite'));
  const args={root,selfId:'test-self',profile:'4'};
  if(phase==='save'){
   const verified=await importWeChat(store,{...args,key,verifyOnly:true},helper);assert.equal(verified.sourceReadable,true);
   vault.saveKey(root,key);vault.saveKey(root,'cd'.repeat(32),'media');auth.save(root,args);
   assert.equal(fs.readFileSync(path.join(temp,'authorized.enc')).includes(Buffer.from(root)),false);
  }
  assert.equal(auth.check(root),'savedUnverified');assert.equal(vault.loadKey(root),key);assert.notEqual(vault.loadKey(root,'media'),key);
  let calls=0;const scheduler=new AutoSync({run:async()=>{calls++;return importWeChat(store,{...auth.get(root).options,root,key:vault.loadKey(root),incremental:true,grantId:auth.get(root).grantId},helper,()=>{},{wait:async()=>{}})}});
  scheduler.configure(root,auth.get(root));const result=await scheduler.request(root,'startup');assert.equal(result.added,phase==='save'?2:0);assert.equal(calls,1);assert.equal(!!result.unchanged,phase==='restart');
  scheduler.close();assert.equal(store.db.prepare('SELECT count(*) n FROM messages').get().n,2);store.close();
  console.log(JSON.stringify({phase,safeStorage:true,encryptedFixture:true,credentialRestored:true,sourceMediaIsolated:true,added:result.added,autoStartup:true,unchangedReceipt:!!result.unchanged}));app.quit();
 }).catch(()=>{console.log(JSON.stringify({phase,result:'FAILED'}));app.exit(1)});
}
