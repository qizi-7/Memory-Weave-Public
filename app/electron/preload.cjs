const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('archive',{...Object.fromEntries(['emojiPack','importEmojiPack','validationImport','validationMedia','validationSync','messageTrace','autoSyncStatus','autoSyncConfigure','autoSyncNow','statsCancel','directory','favorites','saveFavorite','mediaIndex','statMessages','diagnostics','accounts','importArchive','contacts','sessions','messages','find','edit','undo','changes','locate','stats','exportArchive','theme','discoverWeChat','selectWeChat','chooseWeChat','connectWeChat','weChatStatus','weChatImportProgress','syncStatus','syncAction','syncRetry','configureMedia','verifySource','mediaOutcome','mediaRetry','copyWeChatPath','weChatKeyStatus','clearWeChatKey','copyWeChatDiagnostics','aiStart','aiStatus','aiIndex','aiSearch','aiAsk'].map(method=>[method,async(args)=>{try{return await ipcRenderer.invoke('archive:'+method,args)}catch(e){throw Error(String(e.message||e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/,''))}}])) ,onSyncProgress(callback){
 const handler=(_event,progress)=>callback(progress);
 ipcRenderer.on('archive:sync-progress',handler);
 return ()=>ipcRenderer.removeListener('archive:sync-progress',handler);
},onMediaRevision(callback){
 const handler=(_event,account)=>callback(account);
 ipcRenderer.on('archive:media-revision',handler);
 return ()=>ipcRenderer.removeListener('archive:media-revision',handler);
},onMessagesCommitted(callback){
 const handler=(_event,commit)=>callback(commit);
 ipcRenderer.on('archive:messages-committed',handler);
 return ()=>ipcRenderer.removeListener('archive:messages-committed',handler);
}});
