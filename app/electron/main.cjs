const {app,BrowserWindow,ipcMain,dialog,nativeTheme,clipboard,protocol,safeStorage,powerMonitor,nativeImage}=require('electron');
const {createHash,randomUUID}=require('node:crypto');
const {Worker}=require('node:worker_threads');
const path=require('node:path');
const fs=require('node:fs/promises');
const {homedir,tmpdir}=require('node:os');
const {realpathSync,lstatSync}=require('node:fs');
const {pathToFileURL}=require('node:url');
const {ensureRuntime,stopRuntime}=require('./local-runtime.cjs');
const {discoverWeChat,normalizeSelection}=require('./wechat-discovery.cjs');
const {mediaScheme,accountFor,mediaResponse}=require('./message-media.cjs');
const {imageCodes,invalidateImageCodes}=require('./wechat-image.cjs');
// Explicit isolated validation profile; package tests never migrate the normal user's archive.
const validationArg=process.argv.find(arg=>arg.startsWith('--validation-user-data='));
const profile=require('./profile-isolation.cjs').initializeProfile(app,{validationArg});
protocol.registerSchemesAsPrivileged([{scheme:mediaScheme,privileges:{standard:true,secure:true,stream:true}}]);
const discoveredRoots=new Set();let lastWeChatRoot;
const verifiedAccounts=new Map();
const vault=require('./wechat-vault.cjs');
const {retryContexts,sourceCredential}=require('./wechat-retry-context.cjs');
let build;try{build=require('./build-info.json')}catch{build={gitCommit:'unknown',buildId:'unpackaged'}};
const activeImports=new Set();
const importProgress=new Map();
let syncTask,autoSync;
function publishSync(){if(win&&!win.isDestroyed())win.webContents.send('archive:sync-progress',syncTask);}
const viewWorkers=new Map();
let statsJobs;
let win,worker,writerStopping=false,sequence=0; const pending=new Map();
function call(method,args,onProgress,onStart,target=worker){return new Promise((resolve,reject)=>{if(!target)return reject(Object.assign(Error('数据服务正在重启，请稍后重试。'),{code:'WORKER_RESTARTING'}));const id=++sequence;const timer=method==='connectWeChat'?undefined:setTimeout(()=>{pending.delete(id);reject(Error('操作超时，请重新打开应用检查归档状态'));},method==='aiIndex'?1800000:method==='stats'?600000:180000);pending.set(id,{resolve,reject,timer,onProgress,target});onStart?.(id);try{target.postMessage({id,method,args});}catch(error){clearTimeout(timer);pending.delete(id);reject(error);}});}
if(!app.requestSingleInstanceLock())app.quit();
else {
app.on('second-instance',()=>{if(win){if(win.isMinimized())win.restore();win.focus();}});
app.whenReady().then(async()=>{
  console.info('Memory Weave build',JSON.stringify(build));
  const resources=app.isPackaged?process.resourcesPath:path.join(__dirname,'../resources');
  const runtimeResources=app.isPackaged?process.resourcesPath:path.join(__dirname,'../runtime');
  let commitTimer,trace;const commits=new Map();
  const activeTrace=()=>trace&&Date.now()<trace.expires?trace:null;
  function noteTrace(point){
    const t=activeTrace();
    if(!t||t.id!==point.id||t.rowid)return;
    for(const k of ['t1','t3','failure'])if(point[k]!==undefined)t.points[k]=point[k];
  }
  const receive=({id,value,error,code,progress,commit})=>{if(commit){
    const row=commits.get(commit.account)||{account:commit.account,chats:new Set(),added:0};
    const t=activeTrace();
    if(t&&commit.trace?.id===t.id&&!t.rowid){
      noteTrace(commit.trace);t.rowid=commit.trace.rowid;t.points.t4=commit.committedAt;
      row.trace={id:t.id,rowid:t.rowid};
    }
    for(const chat of commit.chats)row.chats.add(chat);row.added+=commit.added;row.revision=commit.revision;row.committedAt=commit.committedAt;commits.set(commit.account,row);
    if(!commitTimer)commitTimer=setTimeout(()=>{commitTimer=null;for(const entry of commits.values())if(win&&!win.isDestroyed())win.webContents.send('archive:messages-committed',{...entry,chats:[...entry.chats]});commits.clear()},75);
    return;
  }const p=pending.get(id);if(!p)return;if(progress){p.onProgress?.(progress);return;}clearTimeout(p.timer);pending.delete(id);error?p.reject(Object.assign(Error(error),{code})):p.resolve(value);};
  const startWriter=()=>{
    const writer=new Worker(path.join(__dirname,'worker.cjs'),{workerData:{database:profile.database,helper:path.join(resources,'native/wechat-reader')}});
    worker=writer;
    writer.on('message',receive);
    const fail=()=>{
      if(worker!==writer)return;
      worker=undefined;
      for(const [id,p] of pending)if(p.target===writer){clearTimeout(p.timer);pending.delete(id);p.reject(Object.assign(Error('数据服务已停止，保留已提交批次。'),{code:'WORKER_RESTARTING'}));}
      if(!writerStopping)setTimeout(()=>{if(!writerStopping&&!worker)startWriter()},1000).unref();
    };
    writer.on('error',fail);writer.on('exit',fail);
  };
  startWriter();
  const readView=async(method,args)=>{
    const group=method==='diagnostics'?'diagnostics':'browse';
    if(!viewWorkers.has(group)){
      await call('accounts'); // The writer must finish initializing the workspace schema.
      if(!viewWorkers.has(group)){
        const created=new Worker(path.join(__dirname,'archive-view-worker.cjs'),{workerData:{database:profile.database}});
        viewWorkers.set(group,created);created.on('message',receive);
        const failView=()=>{for(const [id,p] of pending){if(p.target===created){clearTimeout(p.timer);pending.delete(id);p.reject(Error('归档查询服务已停止，请重试。'));}}};
        created.on('error',failView);
        created.on('exit',()=>{if(viewWorkers.get(group)===created)viewWorkers.delete(group);failView();});
      }
    }
    return call(method,args,undefined,undefined,viewWorkers.get(group));
  };
  statsJobs=new (require('./latest-stats.cjs').LatestStats)(profile.database,()=>call('accounts'));
  let mediaDiscovery,fixtureMediaRoot;
  const fixtureMediaPath=validationArg&&process.argv.includes('--validation-synthetic-media')?
    path.join(app.getPath('userData'),'synthetic-media','xwechat_files','wxid_fixture'):null;
  async function isolatedMediaRoot(){
    if(!fixtureMediaPath||await fs.realpath(fixtureMediaPath)!==fixtureMediaPath)throw Error('需要隔离合成媒体夹具。');
    let remaining=1000;
    async function inspect(dir){
      for(const file of await fs.readdir(dir)){
        if(--remaining<0)throw Error('合成媒体夹具超过范围。');
        const target=path.join(dir,file),stat=await fs.lstat(target);
        if(stat.isDirectory())await inspect(target);
        else if(!stat.isFile()||stat.nlink!==1)throw Error('合成媒体夹具必须是独立文件。');
      }
    }
    await inspect(fixtureMediaPath);
    return fixtureMediaPath;
  }
  const mediaKeys=new Map();
  const sourceKeys=new Map();
  const retryOptions=retryContexts(path.join(app.getPath('userData'),'sync-connection.local.json'));
  const mediaVerified=new Set();
  const mediaOutcomes=new Map();
  const rememberOutcome=(account,rowid,slot,status,type,stage='index')=>{
    mediaOutcomes.set(account+':'+rowid+':'+slot,{status,type,stage});
    if(mediaOutcomes.size>2048)mediaOutcomes.delete(mediaOutcomes.keys().next().value);
  };
  const decryptedAccounts=new Set();
  const rootFor=async account=>{
    if(validationArg)return fixtureMediaRoot&&accountFor(fixtureMediaRoot)===account?fixtureMediaRoot:undefined;
    const selected=[...authorizedRoots].find(root=>accountFor(root)===account);
    if(selected)return selected;
    mediaDiscovery??=discoverWeChat();
    return (await mediaDiscovery).accounts.find(item=>accountFor(item.root)===account&&vault.hasKey(item.root,'media'))?.root;
  };
  const mediaKey=root=>{
    if(mediaKeys.has(root))return mediaKeys.get(root);
    let key;if(vault.hasKey(root,'media'))try{key=vault.loadKey(root,'media')}catch{}
    mediaKeys.set(root,key);return key;
  };
  const ffmpeg=(await Promise.all([
    path.join(resources,'native/ffmpeg'),path.join(homedir(),'.local/bin/ffmpeg'),'/opt/homebrew/bin/ffmpeg','/usr/local/bin/ffmpeg'
  ].map(async file=>await fs.access(file,fs.constants.X_OK).then(()=>file,()=>null)))).find(Boolean);
  protocol.handle(mediaScheme,async request=>{
    if(closedMedia)return new Response(null,{status:503});
    try{
      return await mediaResponse(request,async(account,rowid)=>{
        const [root,row]=await Promise.all([rootFor(account),call('mediaMessage',{account,rowid})]);
        if(!row)return null;
        if(!root){rememberOutcome(account,rowid,new URL(request.url).pathname.split('/').at(-1),'sourceUnavailable',row.kind);return null;}
        const secret=mediaKey(root);
        const slot=new URL(request.url).pathname.split('/').at(-1);
        const mediaType=require('./message-content.cjs').messageContent(row).type;
        let links=[],metadataBlocked=secret?null:'mediaKeyMissing';
        if(['image','video'].includes(mediaType)) {
          let sourceSecret;
          if(authorizedRoots.has(root))try{sourceSecret=sourceCredential(root,sourceKeys,vault)}catch{/* Optional resource lookup must not block already usable media. */}
          if(secret||sourceSecret)links=await call('mediaLocateDetailed',{root,secret,row,slot,sourceSecret}).then(value=>{if(value.links.some(link=>!link.resource))mediaVerified.add(root);metadataBlocked=value.reason;return value.links}).catch(error=>{metadataBlocked=require('./wechat-media-db.cjs').mediaFailure(error.code);return []});
        }
        const onOutcome=(status,decrypted,stage)=>{
          if(decrypted)decryptedAccounts.add(account);
          rememberOutcome(account,rowid,slot,decrypted?'decrypted':status,mediaType,stage);
        };
        return {root,row,links,ffmpeg,metadataBlocked,onOutcome,voice:secret?()=>call('mediaVoice',{root,secret,row}).then(value=>value&&Buffer.from(value)):undefined};
      },async(account,username)=>{
        const root=await rootFor(account);
        const secret=root&&mediaKey(root);
        const note=status=>rememberOutcome(account,username,'avatar',status,'avatar');
        if(!secret){note(root?'mediaKeyMissing':'sourceUnavailable');return null;}
        try{
          const image=await call('mediaAvatar',{root,secret,username});
          if(image?.length)mediaVerified.add(root);
          note(image?.length?'readable':'recordMissing');
          return image&&Buffer.from(image);
        }catch(error){note(error.code==='MEDIA_KEY_MISMATCH'?'mediaKeyMismatch':'mediaDatabaseUnreadable');return null;}
      });
    }catch{return new Response(null,{status:404,headers:{'cache-control':'no-store'}});}
  });
  const entry=pathToFileURL(path.join(__dirname,'../dist/index.html')).href;
  const {authorizations,AutoSync,sourceStamp}=require('./auto-sync.cjs');
  const authorization=authorizations(path.join(app.getPath('userData'),'source-authorizations.enc'),{available:vault.available,encrypt:value=>safeStorage.encryptString(value),decrypt:value=>safeStorage.decryptString(value)});
  const autoStates=new Map(),completions=new Map();
  const syncState=root=>{const row=authorization.get(root),check=authorization.check(root);return {enabled:row?.enabled??false,interval:row?.interval??10,lastSuccess:row?.lastSuccess??null,lastAdded:row?.lastAdded??0,lastNormalCheck:row?.lastNormalCheck??null,lastCommit:row?.lastCommit??null,...autoStates.get(root),keyState:!vault.available()?'storageUnavailable':check==='sourceChanged'?check:verifiedAccounts.has(root)?(vault.hasKey(root)?'verified':'verifiedUnsaved'):autoStates.get(root)?.state||authorization.issue||check};};
  const rememberAuthorization=(root,args)=>{
    vault.saveKey(root,args.key);authorization.save(root,args);
    autoStates.set(root,{state:'verified',failure:null});autoSync.configure(root,authorization.get(root));
  };
  const startSync=async(args)=>{
      if(!args||!authorizedRoots.has(args.root))throw Error('请先选择账号目录');
      if(activeImports.size)throw Error('已有微信同步任务。');
      const {root}=args;
      args={...retryOptions.get(root),...args};
      if(args.incremental){delete args.resumeOnly;delete args.retrySourceId;args.retryFailed=false;}
      if(args.useSaved===true){args.key=vault.loadKey(root);args.allowDecrypted=false;}
      if(!args.incremental)retryOptions.save(args);
      if(!args.incremental&&args.resumeOnly && !(await call('hasSyncWindow',accountFor(root))))return false;
      if(activeImports.size)throw Error('已有微信同步任务。');
      activeImports.add(root);

      delete args.trace;
      const traceTarget=activeTrace();
      if(args.incremental&&traceTarget?.account===accountFor(root)&&!traceTarget.rowid){
        args.trace={id:traceTarget.id,chatHash:traceTarget.chatHash};
        if(args.detectedAt)traceTarget.points.t2=args.detectedAt;
      }
      args.background=true;
      let ready=false;
      let sampleTime=Date.now(),sampleCount=0;
      const work=call('connectWeChat',args,progress=>{
        if(progress.tracePoint){noteTrace(progress.tracePoint);return;}
        if(progress.sourceVerified){
          verifiedAccounts.set(root,{account:progress.account,name:progress.name,verifiedAt:progress.verifiedAt,sourceReadable:true});
          if(args.key)sourceKeys.set(root,args.key);
          if(args.saveKey===true&&args.key)try{rememberAuthorization(root,args)}catch{autoStates.set(root,{state:'storageUnavailable',failure:'STORAGE_UNAVAILABLE'})}
        }
        ready ||= !!progress.ready;
        const now=Date.now();
        let speed=syncTask.speed||0;
        if(progress.checkpointScanned!==undefined&&now-sampleTime>=1000){
          const examined=progress.scanned-progress.checkpointScanned;
          speed=Math.max(0,Math.round((examined-sampleCount)*1000/(now-sampleTime)));
          sampleTime=now;sampleCount=examined;
        }
        syncTask={...syncTask,...progress,ready,speed};
        publishSync();
      },id=>{
        syncTask={id,incremental:args.incremental===true,state:'running',account:accountFor(root),stage:'正在准备微信同步',ready:false,speed:0};
        publishSync();
      });
      const completion=work.then(async result=>{
        if(args.key)sourceKeys.set(root,args.key);
        if(!args.incremental){retryOptions.save({...args,selfId:result.selfId,displayName:result.name});if(!result.failedTables)retryOptions.finish(root);}
        verifiedAccounts.set(root,{account:result.account,name:result.name,selfId:result.selfId,scanned:result.scanned,verifiedAt:result.verifiedAt??Date.now(),sourceReadable:true});
        if(args.saveKey===true&&args.key){
          try{rememberAuthorization(root,{...args,selfId:result.selfId,displayName:result.name});}
          catch{result.warnings.push('导入已完成，但系统安全存储写入失败。');}
        }
        if(!result.unchanged&&result.added){void call('mediaClose').catch(()=>{});mediaOutcomes.clear();if(win&&!win.isDestroyed())win.webContents.send('archive:media-revision',accountFor(root));}
        syncTask={...syncTask,account:result.account,ready:true,state:result.failedTables?(result.incremental?'partial':'error'):result.targeted?'cancelled':'done',stage:result.failedTables?`有 ${result.failedTables} 个分表待重试，已保留检查点`:result.targeted?'定向重试已完成，可继续其余历史同步。':result.incremental?(result.historicalPending?'增量检查完成；仍有独立历史缺口待补齐':'新增消息检查完成'):result.warnings.length?'同步结束，有记录需检查':'聊天记录已同步',warnings:result.warnings,failedTables:result.failedTables,pendingShards:result.pendingShards,integrityIssues:result.integrityIssues,speed:0};
        return result;
      }).catch(error=>{
        syncTask={...syncTask,state:syncTask.state==='cancelling'?'cancelled':'error',stage:error.message,speed:0};
        throw error;
      }).finally(()=>{
        args.key='';
        activeImports.delete(root);
        publishSync();
        if(quitAfterSync)app.quit();
      });
      completions.set(root,completion);
      void completion.catch(()=>{});
      return {taskId:syncTask.id};
  };

  const mediaLifecycle=require('./media-restore.cjs').mediaRestore({vault,deactivate:root=>mediaVerified.delete(root),
    verify:(root,secret)=>call('mediaVerify',{root,secret}),close:root=>call('mediaClose',root),
    activate:(root,secret)=>{mediaKeys.set(root,secret);mediaVerified.add(root)},
    revision:root=>{const account=accountFor(root);for(const id of mediaOutcomes.keys())if(id.startsWith(account+':'))mediaOutcomes.delete(id);if(win&&!win.isDestroyed())win.webContents.send('archive:media-revision',account)}
  });
  const activateMedia=(root,secret,save)=>mediaLifecycle.run(root,secret,save===true);
  const verifySavedMedia=root=>mediaLifecycle.restore(root);

  const emojiPack=new (require('./text-emoji-pack.cjs').EmojiPack)(app.getPath('userData'),bytes=>{const image=nativeImage.createFromBuffer(bytes);return image.isEmpty()?null:image.getSize()});
  for(const route of ['emojiPack','importEmojiPack','validationImport','validationMedia','validationSync','messageTrace','autoSyncStatus','autoSyncConfigure','autoSyncNow','statsCancel','directory','favorites','saveFavorite','mediaIndex','statMessages','diagnostics','accounts','contacts','sessions','messages','find','edit','undo','changes','locate','stats','importArchive','exportArchive','theme','discoverWeChat','selectWeChat','chooseWeChat','connectWeChat','weChatStatus','weChatImportProgress','syncStatus','syncAction','syncRetry','configureMedia','verifySource','mediaOutcome','mediaRetry','copyWeChatPath','weChatKeyStatus','clearWeChatKey','copyWeChatDiagnostics','aiStart','aiStatus','aiIndex','aiSearch','aiAsk']) ipcMain.handle('archive:'+route,async(event,args)=>{
    let method=route;
    if(event.sender!==win?.webContents||event.senderFrame!==win.webContents.mainFrame||event.senderFrame.url!==entry) throw Error('拒绝未知来源');
    if(method==='emojiPack')return emojiPack.get();
    if(method==='importEmojiPack'){
      if(validationArg)throw Error('验证模式禁止打开真实资源选择器。');
      if(args?.rightsConfirmed!==true)throw Error('请先确认资源使用授权。');
      const choice=await dialog.showOpenDialog(win,{properties:['openFile'],filters:[{name:'授权本地表情资源包',extensions:['json']}]});
      if(choice.canceled)return null;
      return emojiPack.import(choice.filePaths[0],true);
    }
    if(method==='messageTrace'){
      if(args?.action==='start'){
        if(!/^wechat:[a-f0-9]{64}$/.test(args.account)||typeof args.chat!=='string'||!args.chat||args.chat.length>1000)return null;
        const chatHash=/^unresolved:[a-f0-9]{32}$/.test(args.chat)?args.chat.slice(11):createHash('md5').update(args.chat).digest('hex');
        trace={id:randomUUID(),account:args.account,chatHash,expires:Date.now()+300000,points:{}};
        return {id:trace.id,points:{}};
      }
      const t=activeTrace();
      if(!t||t.id!==args?.id)return null;
      if(args.action==='stop'){trace=null;return null;}
      if(args.action==='seen'&&!t.points.t0)t.points.t0=Date.now();
      const now=Date.now(),at=Number.isSafeInteger(args.at)&&args.at<=now&&args.at>=now-10000?args.at:now;
      if(args.action==='ipc'&&t.rowid&&t.rowid===args.rowid&&!t.points.t5)t.points.t5=at;
      if(args.action==='dom'&&t.rowid&&t.rowid===args.rowid&&!t.points.t6)t.points.t6=at;
      return {id:t.id,points:{...t.points}};
    }
    if(method==='validationMedia'){
      const root=await isolatedMediaRoot();
      fixtureMediaRoot=root;
      if(args==='saved')return verifySavedMedia(root);
      if(args!==true)return true;
      vault.saveKey(root,'ab'.repeat(32));
      return activateMedia(root,vault.loadKey(root),true);
    }
    if(method==='validationSync'){
      const root=await isolatedMediaRoot();
      authorizedRoots.add(root);
      await startSync({root,selfId:'synthetic_self',allowDecrypted:true,incremental:true,profile:'4',detectedAt:Date.now()});
      return completions.get(root);
    }
    if(method==='validationImport'){
      if(!validationArg)throw Error('仅限隔离测试。');
      const fixture=path.join(app.getPath('userData'),'synthetic-archive.json');
      const stat=lstatSync(fixture);if(!stat.isFile()||stat.nlink!==1)throw Error('无效的合成归档文件。');
      return call('importFile',fixture);
    }
    if(validationArg&&['autoSyncStatus','autoSyncConfigure','autoSyncNow','discoverWeChat','selectWeChat','chooseWeChat','connectWeChat','syncRetry','verifySource','configureMedia','weChatStatus','weChatImportProgress','weChatKeyStatus','clearWeChatKey','copyWeChatPath','copyWeChatDiagnostics'].includes(method))throw Error('验证模式禁止访问真实微信数据源。');
    if(['autoSyncStatus','autoSyncConfigure','autoSyncNow'].includes(method)){
      const root=typeof args==='string'?args:args?.root;
      if(!authorizedRoots.has(root))throw Error('请先选择已授权的账号目录。');
      if(method==='autoSyncStatus')return syncState(root);
      if(method==='autoSyncConfigure'){
        authorization.update(root,{enabled:args.enabled===true,interval:args.interval});
        autoSync.configure(root,authorization.get(root));if(args.enabled===true)void autoSync.request(root,'startup').catch(()=>{});return syncState(root);
      }
      if(activeImports.size)throw Error('已有同步任务，请等待、暂停或恢复当前任务。');
      void autoSync.request(root,'manual').catch(()=>{});return true;
    }
    if(method==='statsCancel')return statsJobs.cancel(args?.requestId);
    if(method==='stats')return statsJobs.run(args?.requestId||'stats-'+(++sequence),args);
    if(['directory','favorites','mediaIndex','statMessages'].includes(method))return readView(method,args);
    if(method==='diagnostics'){
      const account=typeof args==='string'?args:'';
      const data=await readView('diagnostics',account);
      const root=account&&data.current?await rootFor(account).catch(()=>undefined):undefined;
      const exists=async name=>!!root&&await fs.stat(path.join(root,name)).then(stat=>stat.isDirectory()||stat.isFile()).catch(()=>false);
      return {...data,runtimeSync:syncTask?.account===account?syncTask.state:null,
        sourceAvailable:!!root,mediaLibrary:await exists('db_storage/hardlink/hardlink.db')||await exists('msg'),
        imageCache:await exists('cache'),imageCode:root?(await imageCodes(root).catch(()=>[])).length>0:false,
        mediaCredential:!!root&&!!mediaKey(root),isolated:!!validationArg};
    }
    if(method==='importArchive') {const selected=await dialog.showOpenDialog(win,{title:'导入授权的聊天归档（格式 v1）',filters:[{name:'归档 JSON',extensions:['json']}],properties:['openFile']});if(selected.canceled)return null;return call('importFile',selected.filePaths[0]);}
    if(method==='discoverWeChat'){const result=await (mediaDiscovery=discoverWeChat());const accounts=[...result.accounts];for(const row of authorization.list())if(authorization.check(row.root)==='savedUnverified'&&!accounts.some(a=>a.root===row.root))accounts.push({root:row.root,label:row.options.displayName||path.basename(row.root),modifiedAt:0});discoveredRoots.clear();for(const a of accounts)discoveredRoots.add(a.root);return {...result,accounts};}
    if(method==='selectWeChat'){if(typeof args!=='string'||!discoveredRoots.has(args))throw Error('该账号不在本次检测结果中，请重新检测');const info=await normalizeSelection(args);if(info.root!==args)throw Error('账号目录已变化，请重新检测');authorizedRoots.add(info.root);lastWeChatRoot=info.root;return info.root;}
    if(method==='chooseWeChat'){const found=await discoverWeChat();const fs=require('node:fs');let defaultPath=lastWeChatRoot||found.accounts[0]?.root||found.defaultPath;while(!fs.existsSync(defaultPath)&&path.dirname(defaultPath)!==defaultPath)defaultPath=path.dirname(defaultPath);const selected=await dialog.showOpenDialog(win,{title:'选择微信账号目录或 db_storage（请先正常退出微信）',defaultPath,properties:['openDirectory']});if(selected.canceled)return null;const info=await normalizeSelection(selected.filePaths[0]);authorizedRoots.add(info.root);lastWeChatRoot=info.root;return info.root;}
    if(method==='weChatImportProgress'){if(!authorizedRoots.has(args))throw Error('请先选择账号目录');return importProgress.get(args)||null;}
    if(method==='weChatStatus'){
      if(!authorizedRoots.has(args))throw Error('请先选择账号目录');
      const account=accountFor(args),mediaResults=new Map();
      for(const [id,{type,status,stage,render}] of mediaOutcomes)if(id.startsWith(account+':')){
        const tag=[type,status,stage,render].join(':'),prior=mediaResults.get(tag);
        mediaResults.set(tag,{type,status,stage,render,count:(prior?.count||0)+1});
      }
      return {mediaResults:[...mediaResults.values()],
        verification:verifiedAccounts.get(args)||null,
        sync:syncTask?.account===account?syncTask.state:(await call('syncInterrupted'))?.account===account?'cancelled':null,
        mediaKeySaved:vault.hasKey(args,'media'),
        mediaKeyReady:mediaVerified.has(args),
        mediaCredential:mediaLifecycle.state(args),
        imageConfigured:(await imageCodes(args)).length>0,
        imageDecrypted:decryptedAccounts.has(account)
      };
    }
    if(method==='mediaRetry'){
      if(!/^wechat:[a-f0-9]{64}$/.test(args?.account)||!Number.isSafeInteger(args?.rowid)||args.rowid<1)return false;
      const root=await rootFor(args.account);
      if(!root)return false;
      for(const slot of ['preview','play','frame'])mediaOutcomes.delete(args.account+':'+args.rowid+':'+slot);
      invalidateImageCodes(root);
      await call('mediaClose',root).catch(()=>{});
      return true;
    }
    if(method==='mediaOutcome'){
      if(!/^wechat:[a-f0-9]{64}$/.test(args?.account)||!Number.isSafeInteger(args?.rowid))return null;
      const outcome=mediaOutcomes.get(args.account+':'+args.rowid+':'+(['play','frame'].includes(args.slot)?args.slot:'preview'));
      if(outcome&&['shown','failed'].includes(args.render)&&['readable','decrypted'].includes(outcome.status))outcome.render=args.render;
      return args.detail?outcome??null:outcome?.status??null;
    }
    if(method==='verifySource'){
      if(!authorizedRoots.has(args))throw Error('请先选择账号目录');
      const key=sourceCredential(args,sourceKeys,vault);
      if(!key&&!retryOptions.get(args).allowDecrypted)throw Error('请选择逐库密钥 JSON。');
      const result=await call('verifySource',{...retryOptions.get(args),root:args,key});
      verifiedAccounts.set(args,result);
      sourceKeys.set(args,key);
      return result;
    }
    if(method==='copyWeChatPath'){if(!authorizedRoots.has(args))throw Error('请先选择账号目录');clipboard.writeText(args);return true;}
    if(['weChatKeyStatus','clearWeChatKey','copyWeChatDiagnostics'].includes(method)){
      if(!authorizedRoots.has(args))throw Error('请先选择账号目录');
      const status={saved:vault.hasKey(args),available:vault.available(),verifiedAt:verifiedAccounts.get(args)?.verifiedAt??null,state:syncState(args).keyState};
      if(method==='weChatKeyStatus')return status;
      if(method==='copyWeChatDiagnostics'){
        const queries=await call('queryDiagnostics');
        clipboard.writeText(JSON.stringify({version:app.getVersion(),build,platform:process.platform,arch:process.arch,...status,queries,sync:syncTask&&{scanned:syncTask.scanned,checkpointScanned:syncTask.checkpointScanned,saved:syncTask.saved,added:syncTask.added,doneTables:syncTask.doneTables,totalTables:syncTask.totalTables}},null,2));
        return true;
      }
      if(activeImports.has(args))throw Error('正在导入，请等待完成。');
      if(autoSync.busy(args))throw Error('自动同步正在运行，请先取消并等待结束。');
      if(authorization.get(args)){authorization.update(args,{enabled:false});autoSync.configure(args,authorization.get(args));authorization.remove(args);}
      verifiedAccounts.delete(args);autoStates.delete(args);vault.clearKey(args);
      sourceKeys.delete(args);
      return true;
    }
    if(method==='configureMedia'){
      const root=args?.root;
      if(typeof root!=='string'||!authorizedRoots.has(root))throw Error('请先选择账号目录。');
      let secret;
      if(args.mode==='saved'){
        return verifySavedMedia(root);
      }else if(args.mode==='source'){
        if(!vault.hasKey(root))throw Error('此账号尚未保存聊天数据库凭据。');
        secret=vault.loadKey(root);
      }else if(args.mode==='file'){
        const selected=await dialog.showOpenDialog(win,{title:'选择媒体密钥文件',defaultPath:path.join(root,'all_keys.json'),filters:[{name:'密钥文件',extensions:['json','txt']}],properties:['openFile']});
        if(selected.canceled)return false;
        const handle=await fs.open(selected.filePaths[0],'r');
        try{
          const buffer=Buffer.alloc(262145);
          const {bytesRead}=await handle.read(buffer);
          if(bytesRead>262144)throw Error('密钥文件过大。');
          secret=buffer.toString('utf8',0,bytesRead);
        }finally{await handle.close();}
      }else throw Error('请选择媒体凭据来源。');
      return activateMedia(root,secret,args.save);
    }
    if(method==='syncRetry'){
      const status=syncTask||await call('syncInterrupted');
      if(!status||!['error','partial','cancelled'].includes(status.state)||!status.account) return false;
      const root=await rootFor(status.account);
      if(!root)return false;
      authorizedRoots.add(root);
      const retrySourceId=args?.sourceId;
      if(retrySourceId!==undefined&&!/^[a-f0-9]{12}$/.test(retrySourceId))throw Error('待重试分表标识无效。');
      if(status.incremental&&!retrySourceId){void autoSync.request(root,'manual').catch(()=>{});return true;}
      if(status.incremental){
        const retained=retryOptions.get(root),key=sourceCredential(root,sourceKeys,vault);
        if(!key&&!retained.allowDecrypted)throw Error('请重新授权数据库密钥，增量失败断点仍保留。');
        return startSync({...retained,root,key,incremental:true,incrementalSourceId:retrySourceId});
      }
      retryOptions.target(root,retrySourceId);
      const retained=retryOptions.get(root),key=sourceCredential(root,sourceKeys,vault);
      if(!key&&!retained.allowDecrypted)throw Error('请在账号设置重新授权数据库密钥，已保留原定向重试目标。');
      args={...retained,root,key,resumeOnly:true,retryFailed:true,retrySourceId};
      method='connectWeChat';
    }
    if(method==='syncStatus')return syncTask||await call('syncInterrupted');
    if(method==='syncAction'){
      if(!syncTask||args?.id!==syncTask.id||!['running','paused','cancelled'].includes(args.state))throw Error('同步任务已变化。');
      if(!activeImports.size||!['running','paused'].includes(syncTask.state))throw Error('该任务已结束。');
      syncTask={...syncTask,state:args.state==='cancelled'?'cancelling':args.state};
      worker.postMessage({id:syncTask.id,method:'syncControl',args:args.state});
      publishSync();
      return true;
    }
    if(method==='connectWeChat')return startSync(args);
    if(method==='aiStart')return ensureRuntime(runtimeResources,app.getPath('userData'));
    if(method==='exportArchive') {if(!args||!['json','md'].includes(args.format))throw Error('格式无效');const selected=await dialog.showSaveDialog(win,{defaultPath:'chat-archive.'+args.format,filters:[{name:args.format,extensions:[args.format]}]});if(selected.canceled)return null;return call('exportFile',{account:args.account,chat:args.chat,format:args.format,file:selected.filePath});}
    if(method==='theme'){if(!['system','light','dark'].includes(args))throw Error('主题无效');nativeTheme.themeSource=args;return true;}
    return call(method,args);
  });
  autoSync=new AutoSync({stamp:root=>{if(authorization.check(root)!=='savedUnverified')throw Object.assign(Error('微信账号目录不可用或已变化。'),{code:'SOURCE_CHANGED'});return sourceStamp(root)},run:async (root,reason,detectedAt)=>{
    if(authorization.check(root)!=='savedUnverified')throw Object.assign(Error('账号源目录已变化，需要重新授权。'),{code:'SOURCE_CHANGED'});
    if(!vault.available())throw Object.assign(Error('系统安全存储不可用。'),{code:'STORAGE_UNAVAILABLE'});
    if(!vault.hasKey(root))throw Object.assign(Error('需要重新授权数据库密钥。'),{code:'CREDENTIAL_MISSING'});
    if(activeImports.size)throw Object.assign(Error('正在执行其他同步，稍后重试。'),{code:'SYNC_BUSY'});
    const row=authorization.get(root);let key;try{key=vault.loadKey(root)}catch{throw Object.assign(Error('无法读取已保存的数据库密钥，请重新授权。'),{code:'CREDENTIAL_MISSING'})}
    await startSync({...row.options,root,key,incremental:true,grantId:row.grantId||'legacy-source-authorization',forceCheck:reason==='manual',detectedAt});
    return completions.get(root);
  },status:(root,patch)=>{
    autoStates.set(root,{...autoStates.get(root),...patch});
    const saved=Object.fromEntries(['lastSuccess','lastAdded','lastNormalCheck','lastCommit'].filter(key=>patch[key]!==undefined).map(key=>[key,patch[key]]));
    if(Object.keys(saved).length)authorization.update(root,saved);
    if(Object.keys(saved).length&&syncTask?.account===accountFor(root)){
      const info=syncState(root);
      syncTask={...syncTask,lastNormalCheck:info.lastNormalCheck,lastCommit:info.lastCommit,lastSuccess:info.lastSuccess};publishSync();
    }
    if(['mismatch','sourceChanged','reauthorize','storageUnavailable'].includes(patch.state))verifiedAccounts.delete(root);
    if(patch.failure!=='SYNC_CANCELLED'&&(patch.state==='error'||['mismatch','sourceChanged','reauthorize','storageUnavailable'].includes(patch.state))){
      if(!activeImports.size){syncTask={id:++sequence,account:accountFor(root),incremental:true,ready:false,
       state:patch.state==='error'?'error':'authorization',stage:patch.failure};publishSync();}
    }
  }});
  if(!validationArg){
    powerMonitor.on('resume',()=>autoSync.wake());
    if(vault.available()&&!authorization.issue)for(const root of retryOptions.roots()){
      if(!authorization.get(root)&&vault.hasKey(root))try{authorization.save(root,retryOptions.get(root))}catch{} // Prior explicit source-save consent, never media.
    }
    for(const row of authorization.list()){
      if(authorization.check(row.root)!=='savedUnverified'){autoStates.set(row.root,{state:'sourceChanged'});continue}
      authorizedRoots.add(row.root);autoSync.configure(row.root,row);
      if(row.enabled)void autoSync.request(row.root,'startup').catch(()=>{});
    }
  }
  const create=()=>{
    win=new BrowserWindow({width:1280,height:860,minWidth:900,minHeight:600,title:'Memory Weave',titleBarStyle:'hiddenInset',trafficLightPosition:{x:16,y:13},backgroundColor:'#f4f6f9',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
    win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',e=>e.preventDefault());win.webContents.session.setPermissionRequestHandler((_w,_p,callback)=>callback(false));
    win.webContents.once('did-finish-load',()=>{
      // Validation can only touch the explicit synthetic fixture, never discover real roots.
      if(validationArg){void isolatedMediaRoot().then(root=>{if(vault.hasKey(root,'media')){fixtureMediaRoot=root;return mediaLifecycle.restore(root)}}).catch(()=>{});return}
      for(const row of authorization.list())if(authorization.check(row.root)==='savedUnverified'&&vault.hasKey(row.root,'media'))void mediaLifecycle.restore(row.root).catch(()=>{});
    });
    win.loadURL(entry);
  };
  create(); app.on('activate',()=>{if(!BrowserWindow.getAllWindows().length)create();});
});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
let quitAfterSync=false,closedMedia=false;
app.on('before-quit',event=>{
 writerStopping=true;autoSync?.close();
 if(activeImports.size&&syncTask&&worker){
  event.preventDefault();
  if(!quitAfterSync){
   quitAfterSync=true;
   worker.postMessage({id:syncTask.id,method:'syncControl',args:'cancelled'});
  }
  return;
 }
 if(worker&&!closedMedia){
  event.preventDefault();
  closedMedia=true;
  void call('mediaClose').catch(()=>{}).finally(()=>app.quit());
  return;
 }
 statsJobs?.close();
 for(const view of viewWorkers.values())view.terminate();
 worker?.terminate();
});
app.on('before-quit',stopRuntime);
const authorizedRoots=new Set();

}
