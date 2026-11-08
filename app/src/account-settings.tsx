import {EmojiPackSettings} from './text-emoji'
import React,{useEffect,useRef,useState} from 'react'

type Detected={root:string;label:string;modifiedAt:number}
import type {WeChatStatus,AutoSyncStatus,SyncStatus} from './integrations'
function Mark({kind}:{kind:'person'|'key'|'image'|'copy'|'refresh'|'plus'}){
 const paths={person:<><circle cx="12" cy="8" r="4"/><path d="M4 22v-3a8 8 0 0 1 16 0v3"/></>,key:<><circle cx="15.5" cy="8.5" r="5.5"/><path d="m11 12-8 8v2h4v-3h3v-3l3-3m4-6h.01"/></>,image:<><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1"/><path d="m3 17 6-6 4 4 3-3 5 5"/></>,copy:<><rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/></>,refresh:<><path d="M20 4v6h-6M4 20v-6h6M20 10a8 8 0 0 0-13-6M4 14a8 8 0 0 0 13 6"/></>,plus:<path d="M12 4v16M4 12h16"/>}
 return <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind]}</svg>
}
export function WeChatConnection(){
 const [root,setRoot]=useState(''),[detected,setDetected]=useState<Detected[]>([]),[source,setSource]=useState<WeChatStatus|null>(null)
 const [key,setKey]=useState(''),[self,setSelf]=useState(''),[name,setName]=useState(''),[profile,setProfile]=useState('auto'),[allowDecrypted,setAllowDecrypted]=useState(false)
 const [busy,setBusy]=useState(false),[detecting,setDetecting]=useState(false),[notice,setNotice]=useState(''),[failed,setFailed]=useState(false),[manual,setManual]=useState(false),[picker,setPicker]=useState(false)
 const [keyStatus,setKeyStatus]=useState<{saved:boolean;available:boolean;verifiedAt:number|null}|null>(null),[saveKey,setSaveKey]=useState(false),[confirmClear,setConfirmClear]=useState(false)
 const [saveMediaKey,setSaveMediaKey]=useState(false)
 const [auto,setAuto]=useState<AutoSyncStatus|null>(null),[sync,setSync]=useState<SyncStatus|null>(null)
 const verified=source?.verification
 const alive=useRef(true),dialog=useRef<HTMLDialogElement>(null)
 const [mediaChecks,setMediaChecks]=useState<{type:string;index:number;state:string}[]>([])
 const activate=async(selected:string)=>{
  const [status,storage]=await Promise.all([window.archive.weChatStatus(selected),window.archive.weChatKeyStatus(selected)])
  if(!alive.current)return
  setMediaChecks([]);setKeyStatus(storage);setSaveKey(false);setConfirmClear(false);setRoot(selected);setSource(status);setSelf('');setName(status.verification?.name||'');setKey('')
 }
 const detect=async()=>{setDetecting(true);setFailed(false);setNotice('');try{
  const r=await window.archive.discoverWeChat();if(!alive.current)return;setDetected(r.accounts)
  if(r.accounts.length===1)await activate(await window.archive.selectWeChat(r.accounts[0].root))
  else if(r.accounts.length>1)setPicker(true)
  else setNotice('未找到微信账号。可以使用“添加账号”选择自定义数据位置。')
  if(r.warnings.length)setNotice(r.warnings.join(' '))
 }catch(e){if(alive.current){setNotice(String(e));setFailed(true)}}finally{if(alive.current)setDetecting(false)}}
 useEffect(()=>{alive.current=true;void detect();return()=>{alive.current=false}},[])
 useEffect(()=>{
  if(!root)return
  let active=true
  const refresh=()=>void Promise.all([window.archive.weChatStatus(root),window.archive.weChatKeyStatus(root),window.archive.autoSyncStatus(root),window.archive.syncStatus()]).then(([status,storage,schedule,task])=>{if(active){setSource(status);setKeyStatus(storage);setAuto(schedule);setSync(task)}}).catch(()=>{})
  refresh()
  const interval=setInterval(refresh,3000)
  const remove=window.archive.onSyncProgress(refresh)
  return()=>{active=false;clearInterval(interval);remove()}
 },[root])
 useEffect(()=>{if(manual)dialog.current?.showModal()},[manual])
 const choose=async()=>{setDetecting(true);try{const selected=await window.archive.chooseWeChat();if(selected){await activate(selected);setPicker(false);setNotice('已选择账号，请验证数据库密钥。');setFailed(false)}}catch(e){setNotice(String(e));setFailed(true)}finally{setDetecting(false)}}
 const selectDetected=async(value:string)=>{if(!value)return;setDetecting(true);try{await activate(await window.archive.selectWeChat(value));setPicker(false);setNotice('')}catch(e){setNotice(String(e));setFailed(true)}finally{setDetecting(false)}}
 const connect=async(useSaved=false)=>{
  if(!useSaved&&!key&&!allowDecrypted){setNotice('请输入数据库密钥。');setFailed(true);return}
  setBusy(true);setFailed(false);setNotice('正在准备导入…');const secret=key
  try{
   await window.archive.connectWeChat({root,key:secret,selfId:self.trim(),displayName:name.trim(),profile,allowDecrypted,useSaved,saveKey:!useSaved&&saveKey})
   setKey('');setManual(false);setNotice('同步已在后台启动。')
  }catch(e){setNotice(e instanceof Error?e.message:String(e));setFailed(true)}finally{setBusy(false)}
 }
 const configureAuto=async(enabled:boolean,interval:number)=>{try{setAuto(await window.archive.autoSyncConfigure({root,enabled,interval}));setFailed(false);setNotice('自动同步设置已保存。')}catch(e){setNotice(String(e));setFailed(true)}}
 const now=async()=>{try{await window.archive.autoSyncNow(root);setNotice('正在检查新增消息。');setFailed(false)}catch(e){setNotice(String(e));setFailed(true)}}
 const control=async(state:string)=>{try{if(sync)await window.archive.syncAction({id:sync.id,state})}catch(e){setNotice(String(e));setFailed(true)}}
 const keyLabels:Record<string,string>={unconfigured:'未配置',verifiedUnsaved:'本次已验证，未授权保存',savedUnverified:'已保存，待验证',verified:'已保存且验证成功',checking:'正在验证并检查',storageUnavailable:'系统安全存储不可用',mismatch:'密钥与当前数据库不匹配',sourceChanged:'微信账号或源目录已变化',reauthorize:'需要重新授权',error:'同步失败，已保留凭据和断点'}
 const copy=async()=>{try{await window.archive.copyWeChatPath(root);setNotice('已复制数据位置。');setFailed(false)}catch(e){setNotice(String(e));setFailed(true)}}
 const clear=async()=>{try{
  await window.archive.clearWeChatKey(root)
  setKeyStatus(await window.archive.weChatKeyStatus(root));setConfirmClear(false);setNotice('已清除保存的密钥。');setFailed(false)
 }catch(e){setNotice(String(e));setFailed(true)}}
 const copyDiagnostics=async()=>{try{await window.archive.copyWeChatDiagnostics(root);setNotice('已复制诊断信息。');setFailed(false)}catch(e){setNotice(String(e));setFailed(true)}}
 const close=()=>{if(!busy){setKey('');setManual(false)}}
 const label=detected.find(a=>a.root===root)?.label||root.split('/').pop()||''
 return <section className="account-preferences" aria-labelledby="account-heading"><EmojiPackSettings/>
  <header className="prefs-heading"><h1 id="account-heading">账号与数据库</h1><p>当前微信账号、数据位置，以及数据库和图片密钥。</p></header>
  <div className="prefs-card account-summary">
   <div className="account-portrait">{verified?.name?verified.name.slice(0,1):<Mark kind="person"/>}</div>
   <div className="account-summary-copy"><div className="account-summary-name"><h2>{verified?.name||'微信账号'}</h2><span className={'state-pill '+(verified?'is-ready':'')}>{detecting?'检测中':verified?'源库已验证':root?'待验证':'未连接'}</span></div><p>{label||'尚未添加账号'}</p></div>
   <div className="account-summary-actions"><button className="outline-button" onClick={()=>{setPicker(!picker)}} disabled={busy||detecting}><Mark kind="plus"/>添加账号</button><button className={'icon-button '+(detecting?'is-spinning':'')} aria-label="重新检测账号" title="重新检测账号" disabled={busy||detecting} onClick={()=>{void detect()}}><Mark kind="refresh"/></button></div>
  </div>
  {picker&&<div className="prefs-card account-picker"><h3>选择微信账号</h3>{detected.map(a=><button key={a.root} onClick={()=>{void selectDetected(a.root)}} disabled={busy||detecting}><Mark kind="person"/><span>{a.label}</span><span>{a.root===root?'当前账号':'选择'}</span></button>)}<button className="outline-button" onClick={()=>{void choose()}} disabled={busy||detecting}>选择其他数据位置…</button></div>}
  {notice&&<p className={'account-feedback '+(failed?'is-error':'')} role={failed?'alert':'status'}>{notice}</p>}
  <div className="prefs-section-heading"><h3>数据位置</h3><span className="info-mark" title="仅访问你选择的微信账号目录，不修改原始数据库。">i</span></div>
  <div className="prefs-card location-card"><div className="location-main"><h4>会话数据库</h4><div className="location-path"><code title={root}>{root||'尚未选择数据位置'}</code><button className="icon-button" title="复制数据位置" aria-label="复制数据位置" disabled={!root} onClick={()=>{void copy()}}><Mark kind="copy"/></button></div></div>
   <details className="prefs-details"><summary>技术详情</summary><dl><dt>目录标识</dt><dd>{label||'—'}</dd><dt>数据源类型</dt><dd>wechat-4</dd><dt>读取状态</dt><dd>{verified?.sourceReadable?'源库只读验证通过，按需打开':'尚未验证微信源库'}</dd><dt>历史同步</dt><dd>{source?.sync==='running'?'运行中':source?.sync==='partial'?'部分成功，有分表待重试':source?.sync==='error'?'有失败待重试':source?.sync==='paused'?'已暂停':source?.sync==='done'?'已完成':source?.sync==='cancelled'?'已停止，可从断点继续':'未运行'}</dd><dt>原始数据库</dt><dd>只读访问</dd>{verified&&<><dt>最近验证</dt><dd>{new Date(verified.verifiedAt).toLocaleString('zh-CN')}</dd></>}</dl><button className="text-button" onClick={()=>{void choose()}} disabled={busy||detecting}>更改数据位置</button></details>
  </div>
  <div className="prefs-section-heading"><h3>数据库密钥</h3><span className="info-mark" title="可在验证成功后选择使用系统安全存储。">i</span></div>
  <div className="prefs-card capability-card"><div className="capability-icon"><Mark kind="key"/></div><div className="capability-copy"><h4>数据库密钥</h4><p>{verified?'本次验证已通过。':'尚未验证。可以先验证源库，再按需启动同步。'}</p></div><div className="capability-actions"><button className="outline-button" disabled title="自动获取数据库密钥尚未接入">自动获取 · 未接入</button><button className="text-button" disabled={!root||busy||detecting} onClick={()=>{setManual(true);setNotice('')}}>{keyStatus?.saved?'更换密钥':'手动填写'}</button></div></div>
  {root&&<div className="prefs-card location-card"><details className="prefs-details"><summary>密钥状态与管理</summary>
   <dl><dt>安全保存</dt><dd>{keyStatus?.saved?'已保存':'未保存'}</dd><dt>本次验证</dt><dd>{verified?new Date(verified.verifiedAt).toLocaleString('zh-CN'):'尚未验证'}</dd><dt>本人 wxid</dt><dd>{verified?.selfId||'验证时识别'}</dd></dl>
   <button className="text-button" onClick={copyDiagnostics}>复制诊断信息</button>
   {keyStatus?.saved&&<><button className="text-button" disabled={busy} onClick={()=>{void connect(true)}}>使用已保存密钥补齐历史</button><button className="text-button" disabled={busy} onClick={()=>setConfirmClear(true)}>清除密钥</button></>}
   {confirmClear&&<p>删除本应用保存的密钥？<button className="outline-button" disabled={busy} onClick={clear}>确认清除</button><button className="text-button" onClick={()=>setConfirmClear(false)}>取消</button></p>}
  </details></div>}
  {root&&<><div className="prefs-section-heading"><h3>自动增量同步</h3></div><div className="prefs-card location-card"><div className="location-main">
   <p>首次验证并选择保存数据库密钥后可用。仅在应用打开时运行；历史缺口另行补齐。</p>
   <label className="decrypted-choice"><input type="checkbox" checked={auto?.enabled??false} disabled={!keyStatus?.saved} onChange={e=>{void configureAuto(e.target.checked,auto?.interval??2)}}/>自动检测新增微信消息</label>
   <label>检查频率 <select aria-label="自动同步频率" value={auto?.interval??2} disabled={!keyStatus?.saved} onChange={e=>{void configureAuto(auto?.enabled??false,Number(e.target.value))}}>{[1,2,3,5,10,15,30].map(n=><option key={n} value={n}>{n} 分钟</option>)}</select></label>
   <dl><dt>数据库凭据</dt><dd>{keyLabels[auto?.keyState||'unconfigured']||'等待检查'}</dd><dt>上次正常分表检查</dt><dd>{auto?.lastNormalCheck?new Date(auto.lastNormalCheck).toLocaleString('zh-CN'):'尚无记录'}</dd><dt>上次提交新消息</dt><dd>{auto?.lastCommit?new Date(auto.lastCommit).toLocaleString('zh-CN'):'尚无记录'}</dd><dt>上次全分表检查通过</dt><dd>{auto?.lastSuccess?new Date(auto.lastSuccess).toLocaleString('zh-CN'):'尚未成功'}</dd><dt>上次新增</dt><dd>{auto?.lastAdded??0} 条</dd><dt>下次自动检查</dt><dd>{auto?.enabled&&auto?.nextCheck?new Date(auto.nextCheck).toLocaleString('zh-CN'):'未安排'}</dd><dt>失败原因</dt><dd>{auto?.failure||'无'}</dd><dt>变化监听</dt><dd>{auto?.watcherFallback?'定时轮询兜底':'文件变化防抖 + 定时轮询'}</dd></dl>
   {!!auto?.integrityIssues&&<p role="status">有 {auto.integrityIssues} 项来源差异待人工核对。已保留原归档；可复制诊断查看脱敏分类。</p>}
   {sync&&sync.account===verified?.account&&<p role="status">{sync.stage} · 已处理 {sync.scanned??0} 条，本轮新增 {sync.added??0} 条</p>}
   <button className="outline-button" disabled={!keyStatus?.saved||sync?.state==='running'||sync?.state==='paused'} onClick={()=>{void now()}}>立即同步</button>
   {sync?.state==='running'&&<button className="text-button" onClick={()=>{void control('paused')}}>暂停</button>}{sync?.state==='paused'&&<button className="text-button" onClick={()=>{void control('running')}}>恢复</button>}
   {(sync?.state==='running'||sync?.state==='paused')&&<button className="text-button" onClick={()=>{void control('cancelled')}}>取消本次同步</button>}
   {auto?.failure&&<button className="text-button" onClick={()=>{void now()}}>重试增量检查</button>}
  </div></div></>}
  <div className="prefs-section-heading"><h3>本地媒体</h3></div>
  <div className="prefs-card capability-card image-capability">
   <div className="capability-icon"><Mark kind="image"/></div>
   <div className="capability-copy"><h4>图片、视频、语音与头像</h4><p>媒体数据库密钥 {({unauthorized:'未授权',storageUnavailable:'系统安全存储不可用',savedUnverified:'已保存，待验证',verifying:'已保存，正在验证',ready:'已保存且可用',temporary:'本次已验证但未保存',partial:'部分媒体库可用',unreadable:'凭据失效或数据库不可读'} as Record<string,string>)[source?.mediaCredential?.state||'']||(source?.mediaKeySaved?'已保存，待验证':'未授权')}。图片缓存码 {source?.imageConfigured?'已检测到':'未检测到'}。{source?.imageDecrypted?'本次已成功解密图片。':'尚无本次解密结果。'}</p><p>已授权的媒体凭据会自动复用；仅更换密钥文件会打开文件选择器。<label className="decrypted-choice"><input type="checkbox" checked={saveMediaKey} onChange={e=>setSaveMediaKey(e.target.checked)} disabled={busy}/>保存到系统安全存储</label></p></div>
   {(['saved','source','file'] as const).map(mode=><button key={mode} className="outline-button" disabled={!root||busy||detecting||(mode==='source'&&!keyStatus?.saved)||(mode==='saved'&&!source?.mediaKeySaved)} onClick={async()=>{
    setBusy(true);setFailed(false);setNotice('');setMediaChecks([])
    try{
     const result=await window.archive.configureMedia({root,save:saveMediaKey,mode})
     if(result){setMediaChecks(result.results);setSource(await window.archive.weChatStatus(root));setFailed(!result.available);setNotice(result.available?(result.saveFailed?'媒体本次可用，但安全保存失败；重启后需要重新授权。':result.saved?'媒体凭据已安全保存，已验证的媒体库可用。':'媒体本次可用，尚未安全保存；请勾选保存后再次授权。'):'没有可解锁的媒体库。若凭据不匹配，请提供单独的媒体凭据。')}
    }catch(e){setNotice(e instanceof Error?e.message:String(e));setFailed(true)}
    finally{setBusy(false)}
   }}>{({saved:'验证已保存的媒体凭据',source:'尝试使用已保存凭据解锁媒体',file:'更换媒体密钥文件…'})[mode]}</button>)}
   {!!source?.mediaResults?.length&&<details><summary>本次读取诊断（近期尝试）</summary><ul>{source.mediaResults.map(({type,status,count,stage,render})=><li key={[type,status,stage,render].join(':')}>{({avatar:'头像',image:'图片',video:'视频',voice:'语音'} as Record<string,string>)[type]||'媒体'}：{({readable:'文件可读',decrypted:'解密成功',recordMissing:'无头像记录',resourceMissing:'本机未找到文件',metadataMissing:'缺少定位元数据',mediaKeyMissing:'未配置凭据',mediaIndexMissing:'媒体索引没有对应记录',mediaKeyMismatch:'凭据不匹配',mediaDatabaseUnreadable:'数据库不可读',imageKeyMissing:'缺少图片缓存码',decryptFailed:'解密失败',decoderUnavailable:'缺少解码器',sourceUnavailable:'未授权或未定位来源',formatUnsupported:'格式不支持',voiceUnreadable:'语音库或解码器不可用'} as Record<string,string>)[status]||status} · {({metadata:'元数据',index:'索引定位',path:'路径验证',open:'文件打开',header:'文件头',decrypt:'解密',decode:'解码',response:'本地响应'} as Record<string,string>)[stage||'']||stage||'—'}{render==='shown'?' · 已显示':render==='failed'?' · 渲染失败':''} · {count}</li>)}</ul></details>}
   {!!mediaChecks.length&&<ul>{mediaChecks.map(({type,index,state})=><li key={index}>{type}库 {index+1}：{({verified:'凭据有效',missing:'数据库不存在',mismatch:'密钥不匹配或无对应条目',unreadable:'数据库无法读取'} as Record<string,string>)[state]||state}</li>)}</ul>}
  </div>
  {manual&&<dialog className="key-dialog" ref={dialog} onCancel={e=>{e.preventDefault();close()}} aria-labelledby="key-heading"><header><h2 id="key-heading">填写数据库密钥</h2><p>将创建数据与日志的本机副本后验证；若数据持续变化，请先正常退出微信。</p></header><form onSubmit={e=>{e.preventDefault();void connect()}}><label>数据库密钥<input autoFocus type="password" value={key} onChange={e=>setKey(e.target.value)} autoComplete="off" spellCheck={false} placeholder="十六进制密钥或逐库密钥 JSON" disabled={busy}/></label><p className="muted">验证时自动识别本人微信账号。各库密钥不同时，可粘贴按数据库相对路径组织的 JSON，例如 all_keys.json 的内容。</p><label>账号名称<input value={name} onChange={e=>setName(e.target.value)} placeholder="读取后的显示名称" disabled={busy}/></label>{keyStatus?.available&&<label className="decrypted-choice"><input type="checkbox" checked={saveKey} onChange={e=>setSaveKey(e.target.checked)} disabled={busy}/>验证成功后安全保存密钥</label>}<details className="key-advanced"><summary>高级选项</summary><label>本人 wxid（可选）<input value={self} onChange={e=>setSelf(e.target.value)} autoComplete="off" placeholder="默认自动识别，仅在识别失败时填写" disabled={busy}/></label><label>加密兼容配置<select value={profile} onChange={e=>setProfile(e.target.value)} disabled={busy}><option value="auto">自动尝试兼容模式</option><option value="4">SQLCipher 4 默认</option><option value="3">SQLCipher 3 兼容</option></select></label><label className="decrypted-choice"><input type="checkbox" checked={allowDecrypted} onChange={e=>setAllowDecrypted(e.target.checked)} disabled={busy}/>我选择的是已解密的数据库副本</label><small>仅勾选此项时允许不填密钥。原始微信加密库必须填写密钥。</small></details>{notice&&<p role={failed?'alert':'status'} className={'account-feedback '+(failed?'is-error':'')}>{notice}</p>}<footer><button type="button" className="outline-button" onClick={close} disabled={busy}>取消</button><button className="primary" disabled={busy||(!key&&!allowDecrypted)}>{busy?'处理中…':'验证并导入'}</button></footer></form></dialog>}
 </section>
}
