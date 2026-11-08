const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {guardProfile,initializeProfile}=require('../electron/profile-isolation.cjs');
const {freezeArchive,digest}=require('../electron/archive-backup.cjs');
const {reviewBase}=require('../../scripts/stage-review.cjs');
const {Store}=require('../electron/store.cjs');
const {saveFavorite}=require('../electron/archive-views.cjs');
function fixture(t){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'mw-next-test-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root}
function appMock(appData){const paths={appData};return {paths, switches:{},getPath:k=>paths[k],setPath:(k,v)=>paths[k]=v,setName(v){this.name=v},commandLine:{appendSwitch:(k,v)=>paths[k]=v}}}
test('Next production identity and every profile are distinct; restart retains own archive, edit and favorite',t=>{
 const root=fixture(t),legacy=path.join(root,'memory-weave');fs.mkdirSync(legacy);fs.writeFileSync(path.join(legacy,'old-user-file'),'unchanged');
 const app=appMock(root),next=initializeProfile(app,{argv:[]});assert.equal(app.name,'memory-weave-next');assert.notEqual(next.root,legacy);assert.equal(app.paths.sessionData,path.join(next.root,'chromium'));
 assert.equal(fs.existsSync(path.join(next.root,'wechat-keys')),false);assert.equal(fs.existsSync(path.join(next.root,'auto-sync.json')),false);
 const store=new Store(next.database);store.importData({version:1,account:{id:'fixture',name:'Synthetic'},contacts:[{id:'peer',name:'Synthetic'}],messages:[{id:'m1',chat:'peer',sender:'peer',timestamp:1700000000,kind:'text',text:'synthetic',outgoing:false}]});
 const rowid=store.db.prepare('SELECT rowid FROM messages').get().rowid;store.edit({account:'fixture',rowid,text:'edited',note:'memo',hidden:false,ts:1700000000});saveFavorite(store.db,{account:'fixture',rowid,saved:true});store.close();
 const again=initializeProfile(appMock(root),{argv:[]});assert.equal(again.root,next.root);const reopened=new Store(again.database);assert.equal(reopened.db.prepare('SELECT count(*) n FROM messages').get().n,1);assert.equal(reopened.db.prepare('SELECT note FROM edits').get().note,'memo');assert.equal(reopened.db.prepare('SELECT count(*) n FROM local_favorites').get().n,1);reopened.close();
 assert.equal(fs.readFileSync(path.join(legacy,'old-user-file'),'utf8'),'unchanged');assert.equal(fs.existsSync(path.join(legacy,'workspace.sqlite')),false);
});
test('canonical overlap, symlink, hardlink and Chromium path overrides fail closed without modifying user files',t=>{
 assert.throws(()=>guardProfile('relative'),/绝对/);
 const root=fixture(t),old=path.join(root,'old'),next=path.join(root,'next');fs.mkdirSync(old);fs.mkdirSync(next);fs.writeFileSync(path.join(old,'workspace.sqlite'),'sentinel');
 assert.throws(()=>guardProfile(path.join(old,'nested'),{legacyRoots:[old]}),/重叠/);assert.throws(()=>guardProfile(root,{legacyRoots:[old]}),/重叠/);
 fs.symlinkSync(old,path.join(next,'cache'));assert.throws(()=>guardProfile(next),/符号链接/);fs.unlinkSync(path.join(next,'cache'));
 fs.linkSync(path.join(old,'workspace.sqlite'),path.join(next,'workspace.sqlite'));assert.throws(()=>guardProfile(next),/独立/);fs.unlinkSync(path.join(next,'workspace.sqlite'));
 fs.symlinkSync(next,path.join(root,'redirect'));assert.throws(()=>guardProfile(path.join(root,'redirect')),/符号链接/);
 assert.throws(()=>initializeProfile(appMock(root),{argv:['--user-data-dir='+old]}),/不匹配/);assert.equal(fs.readFileSync(path.join(old,'workspace.sqlite'),'utf8'),'sentinel');
});
test('synthetic validation remains temporary and separate; unidentified production profiles are never adopted',t=>{
 const root=fixture(t),data=path.join(root,'appData');fs.mkdirSync(data);const temp=path.join(root,'validation');fs.mkdirSync(temp);fs.writeFileSync(path.join(temp,'fixture'),'synthetic');
 const profile=initializeProfile(appMock(data),{validationArg:'--validation-user-data='+temp,argv:[]});assert.equal(profile.root,temp);
 const next=path.join(data,'memory-weave-next');fs.mkdirSync(next);fs.writeFileSync(path.join(next,'foreign'),'do-not-touch');assert.throws(()=>initializeProfile(appMock(data),{argv:[]}),/人工核对/);assert.equal(fs.readFileSync(path.join(next,'foreign'),'utf8'),'do-not-touch');
 assert.throws(()=>guardProfile('/nonexistent-next-validation',{validation:true}),/临时/);
});
test('Online Backup includes committed WAL, excludes uncommitted changes and restores identical stable rows',async t=>{
 const root=fixture(t),src=path.join(root,'source'),dest=path.join(root,'frozen'),restore=path.join(root,'restore');for(const dir of [src,dest,restore])fs.mkdirSync(dir);
 const source=path.join(src,'workspace.sqlite'),db=new DatabaseSync(source);t.after(()=>db.close());db.exec("PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;CREATE TABLE messages(id TEXT,body TEXT);INSERT INTO messages VALUES('committed','synthetic');BEGIN;INSERT INTO messages VALUES('uncommitted','not backed up')");
 assert.ok(fs.statSync(source+'-wal').size>0);const before=await digest(source+'-wal');
 const result=await freezeArchive({source,destination:path.join(dest,'workspace.sqlite'),restore:path.join(restore,'workspace.sqlite'),reserveBytes:0});assert.equal(result.tables.messages.count,1);assert.equal(result.stableIdentitiesEqual,true);assert.equal(result.integrity,'ok');assert.equal(result.restoreIntegrity,'ok');assert.equal(await digest(source+'-wal'),before);assert.notEqual(fs.statSync(path.join(dest,'workspace.sqlite')).ino,fs.statSync(path.join(restore,'workspace.sqlite')).ino);
 db.exec('ROLLBACK');await assert.rejects(freezeArchive({source,destination:path.join(dest,'workspace.sqlite'),restore:path.join(restore,'workspace.sqlite'),reserveBytes:0}),/覆盖/);
});
test('stacked review base is explicit and cannot inject an option or path traversal',()=>{
 assert.equal(reviewBase({}),'main');assert.equal(reviewBase({baseBranch:'codex/0.3.8-auto-sync'}),'codex/0.3.8-auto-sync');for(const baseBranch of ['--all','../main','codex/../main','codex//bad','other/main'])assert.throws(()=>reviewBase({baseBranch}));
});
test('existing encrypted database/media credentials are not copied or cross-read by Next vault',t=>{
 const root=fixture(t),vm=require('node:vm'),source=fs.readFileSync(path.join(__dirname,'../electron/wechat-vault.cjs'),'utf8');
 function vault(directory){const module={exports:{}};const mock={app:{getPath:()=>directory},safeStorage:{isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from('synthetic-cipher:'+value),decryptString:bytes=>bytes.toString().slice(17)}};
  vm.runInNewContext('(function(require,module){'+source+'})',( {Buffer,process:{platform:'darwin'}}))(name=>name==='electron'?mock:require(name),module);return module.exports}
 const old=vault(path.join(root,'old')),next=vault(path.join(root,'next')),sourceRoot='/synthetic/authorized-source';old.saveKey(sourceRoot,'fixture-db');old.saveKey(sourceRoot,'fixture-media','media');assert.equal(next.hasKey(sourceRoot),false);assert.equal(next.hasKey(sourceRoot,'media'),false);assert.throws(()=>next.loadKey(sourceRoot),/没有/);
 next.saveKey(sourceRoot,'next-db');assert.equal(next.hasKey(sourceRoot,'media'),false);assert.equal(old.loadKey(sourceRoot),'fixture-db');assert.equal(old.loadKey(sourceRoot,'media'),'fixture-media');
});
