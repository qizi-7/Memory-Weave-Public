import React, {useContext,useEffect,useLayoutEffect,useRef,useState,useDeferredValue,useMemo} from 'react'
import {createRoot} from 'react-dom/client'
import './style.css'
import {Directory,Diagnostics,ArchiveList,Analysis,type ArchiveViewsAPI} from './archive-pages'
import {MessageBody,MediaRevisions,type ContentData} from './message-body'
import {WeChatConnection,AIPage,type SyncStatus,type IntegrationAPI} from './integrations'
type Account={id:string;name:string}
type Contact={preview?:string;id:string;name:string;count:number;latest:number|null}
type Message={rowid:number;account:string;displayContent:string;contentData:ContentData;id:string;chat:string;chatName?:string;sender:string;senderName?:string;ts:number;note:string;outgoing:number;edited:number;hidden:number;favorited?:boolean}
type Trace={id:string;points:Record<string,number|string>};
type Commit={account:string;chats:string[];added:number;revision:number;committedAt:number;trace?:{id:string;rowid:number}}
type API={messageTrace(args:{action:string;id?:string;account?:string;chat?:string;rowid?:number;at?:number}):Promise<Trace|null>;onMessagesCommitted(callback:(commit:Commit)=>void):()=>void;accounts():Promise<Account[]>;importArchive():Promise<{added:number}|null>;contacts(a:string):Promise<Contact[]>;sessions(a:string):Promise<Contact[]>;messages(a:unknown):Promise<Message[]>;find(a:unknown):Promise<Message[]>;edit(a:unknown):Promise<boolean>;undo(a:unknown):Promise<boolean>;changes(a:string):Promise<Message[]>;locate(a:unknown):Promise<{chat:string;offset:number;rowid:number}>;exportArchive(a:unknown):Promise<{count:number}|null>;theme(t:string):Promise<boolean>}
declare global {interface Window{archive:API & IntegrationAPI & ArchiveViewsAPI}}
const navigation=[['chat','聊天','chat'],['contacts','通讯录','people'],['favorites','收藏','bookmark'],['moments','朋友圈','circle'],['media','图片与视频','image'],['analytics','聊天分析','chart'],['annual','年度报告','calendar'],['advanced','高级功能','diamond'],['other','其他资料','box'],['diagnostics','数据诊断','box'],['ai','AI 助手','bot'],['export','导出中心','download']] as const
function Icon({name}:{name:string}){
 const paths:Record<string,React.ReactNode>={chat:<path d="M20 11.5a8 8 0 0 1-8 8 9 9 0 0 1-3-.5L4 20l1-4a8 8 0 1 1 15-4.5Z"/>,people:<><circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M21 21v-3a6 6 0 0 0-3-5"/></>,bookmark:<path d="M6 3h12v18l-6-4-6 4Z"/>,circle:<><circle cx="12" cy="12" r="9"/><path d="m12 3 5 9-5 9-5-9Z"/></>,image:<><rect x="3" y="3" width="18" height="18" rx="3"/><path d="m3 17 6-6 5 5 4-3 3 3"/><circle cx="16" cy="8" r="1"/></>,chart:<path d="M4 3v17h17M8 14l4-5 4 3 5-7"/>,calendar:<><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 2v6M17 2v6M3 11h18m-14 5 3 3 6-5"/></>,diamond:<path d="m3 8 4-5h10l4 5-9 13Zm0 0h18M7 3l5 18 5-18"/>,box:<><path d="M3 3h18v5H3Zm2 5v13h14V8M9 12h6"/></>,bot:<><rect x="4" y="7" width="16" height="13" rx="3"/><path d="M12 3v4M8 12v3M16 12v3M1 12v4m22-4v4"/></>,download:<path d="M12 3v12m-5-5 5 5 5-5M4 15v6h16v-6"/>,search:<><circle cx="10" cy="10" r="7"/><path d="m16 16 5 5"/></>,settings:<><circle cx="12" cy="12" r="4"/><path d="m12 2 2 3 4 1v4l3 2-3 2v4l-4 1-2 3-2-3-4-1v-4l-3-2 3-2V6l4-1Z"/></>,panel:<><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18m7-14-3 5 3 5"/></>,lock:<><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4"/></>}
 return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]||paths.box}</svg>
}
const sessionDate=new Intl.DateTimeFormat('zh-CN',{month:'numeric',day:'numeric'})
const sessionTime=new Intl.DateTimeFormat('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false})
function AvatarImage({account,id,name}:{account:string;id:string;name:string}) {
 const revision=useContext(MediaRevisions)[account]||0
 const [failed,setFailed]=useState(-1),[loadedRevision,setLoadedRevision]=useState<number|null>(null)
 const activeRevision=loadedRevision??revision
 const initials=Array.from(name.trim())[0]||'·'
 return <div className="avatar">{failed!==revision&&/^wechat:[a-f0-9]{64}$/.test(account)&&id
  ? <img key={activeRevision} loading="lazy" alt="" src={`mw-media://archive/${account.slice(7)}/avatar/${encodeURIComponent(id)}?rev=${activeRevision}`} onLoad={()=>setLoadedRevision(activeRevision)} onError={()=>{setLoadedRevision(null);setFailed(revision)}}/>
  : initials}</div>
}
function Avatar(props:{account:string;id:string;name:string}) {return <AvatarImage key={props.account+':'+props.id} {...props}/>}
function latestLabel(t:number){
 const timestamp=new Date(t*1000)
 return timestamp.toDateString()===new Date().toDateString()?sessionTime.format(timestamp):sessionDate.format(timestamp)
}
const date=(t:number)=>new Date(t*1000).toLocaleString('zh-CN',{hour12:false})
function App(){
 const [accounts,setAccounts]=useState<Account[]>([]),[account,setAccount]=useState(''),[chat,setChat]=useState(''),[messages,setMessages]=useState<Message[]>([]),[page,setPage]=useState('chat'),[collapsed,setCollapsed]=useState(false),[theme,setTheme]=useState(localStorage.getItem('theme')||'system'),[filter,setFilter]=useState(''),[query,setQuery]=useState(''),[results,setResults]=useState<Message[]>([]),[searching,setSearching]=useState(false),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[offset,setOffset]=useState(0),[changes,setChanges]=useState<Message[]>([]),[edit,setEdit]=useState<(Message & {localText?:string})|null>(null),[format,setFormat]=useState('json'),[highlight,setHighlight]=useState(0)
 const pendingLocate=useRef<{account:string;chat:string;offset:number;rowid:number}|null>(null)
 const generation=useRef(0),request=useRef(0),liveApplied=useRef(0)
 const [sessionRevision,bumpSessions]=useState(0),[liveRevision,setLiveRevision]=useState(0),[pendingLatest,setPendingLatest]=useState(false)
 const messageList=useRef<HTMLDivElement>(null)
 const scrollTarget=useRef<'bottom'|{height:number;top:number}|{anchor:string;offset:number}|null>(null)
 const olderInFlight=useRef<number|null>(null)
 const [moreHistory,setMoreHistory]=useState(false),[loadingOlder,setLoadingOlder]=useState(false),[reload,setReload]=useState(0)
 const [sync,setSync]=useState<SyncStatus|null>(null),[showSync,setShowSync]=useState(false)
 const [sessions,setSessions]=useState<Contact[]>([]),[sessionStatus,setSessionStatus]=useState<'loading'|'loaded'|'error'>('loading')
 const sessionRequest=useRef(0)
 const [accountsReady,setAccountsReady]=useState(false)
 const canImport=accountsReady && (!account || (sessionStatus==='loaded'&&!sessions.length))
 const readyJob=useRef<number|null>(null)
 const [trace,setTrace]=useState<Trace|null>(null)
 const tracedRow=useRef<{id:string;rowid:number}|null>(null)
 const traceAction=async(action:string)=>{const next=await window.archive.messageTrace({action,id:trace?.id,account,chat});setTrace(next);if(!next)tracedRow.current=null}
 const markTraceDOM=()=>{
  const row=tracedRow.current,list=messageList.current
  if(!row||!list||page!=='chat'||searching)return
  const item=document.getElementById('message-'+row.rowid)
  if(!item||!list.contains(item))return
  const bounds=item.getBoundingClientRect(),view=list.getBoundingClientRect()
  if(bounds.bottom<=view.top||bounds.top>=view.bottom)return
  tracedRow.current=null
  void window.archive.messageTrace({action:'dom',...row,at:Date.now()}).then(setTrace).catch(()=>{})
 }
 const [mediaRevisions,setMediaRevisions]=useState<Record<string,number>>({})
 useEffect(()=>window.archive.onMediaRevision(a=>setMediaRevisions(r=>({...r,[a]:(r[a]||0)+1}))),[])
 useEffect(()=>{
  let active=true,received=false
  const accept=(status:SyncStatus)=>{
   received=true
   setSync(status)
   if(status.ready&&status.account&&!status.incremental&&readyJob.current!==status.id){
    readyJob.current=status.id
    setAccount(status.account);setPage('chat')
    void window.archive.accounts().then(setAccounts).catch(e=>setNotice(String(e)))
   }
  }
  const remove=window.archive.onSyncProgress(accept)
  void window.archive.syncStatus().then(status=>{if(active&&!received&&status)accept(status)}).catch(e=>setNotice(String(e)))
  return()=>{active=false;remove()}
 },[])
 useEffect(()=>window.archive.onMessagesCommitted(commit=>{
  if(commit.trace&&commit.trace.id===trace?.id){
   tracedRow.current=commit.trace
   void window.archive.messageTrace({action:'ipc',...commit.trace,at:Date.now()}).catch(()=>{})
  }
  if(commit.account!==account)return
  bumpSessions(n=>n+1)
  if(chat&&commit.chats.includes(chat))setLiveRevision(commit.revision)
 }),[account,chat,trace?.id])
 useEffect(()=>{
  if(account)void refresh(account).catch(e=>setNotice(String(e)))
  return()=>{sessionRequest.current++}
 },[account,sessionRevision,sync?.ready])
 const deferredFilter=useDeferredValue(filter)
 const filteredSessions=useMemo(()=>{
  const query=deferredFilter.trim().toLocaleLowerCase()
  return sessions.filter(c=>c.name.toLocaleLowerCase().includes(query)||c.id.toLocaleLowerCase().includes(query))
 },[sessions,deferredFilter])
 const retrySync=()=>void window.archive.syncRetry().then(started=>{if(!started)setPage('settings')}).catch(e=>setNotice(String(e)))
 const syncAction=(state:string)=>{if(sync)void window.archive.syncAction({id:sync.id,state}).catch(e=>setNotice(String(e)))}
 const current=sessions.find(c=>c.id===chat)
 const run=async<T,>(fn:()=>Promise<T>):Promise<T|undefined>=>{setBusy(true);setNotice('');try{return await fn()}catch(e){setNotice(e instanceof Error?e.message:String(e))}finally{setBusy(false)}}
 const refresh=async(a:string)=>{
  const id=++sessionRequest.current
  try{
   const list=await window.archive.sessions(a)
   if(id===sessionRequest.current){setSessions(list);setSessionStatus('loaded')}
  }catch(error){
   if(id===sessionRequest.current)setSessionStatus('error')
   throw error
  }
 }
 useEffect(()=>{
  if(!account||page!=='other')return
  let active=true
  const task=window.archive.changes(account).then(value=>{if(active)setChanges(value)})
  void task.catch(error=>{if(active)setNotice(String(error))})
  return()=>{active=false}
 },[account,page,sync?.state])
 useEffect(()=>{window.archive.accounts().then(a=>{setAccounts(a);setAccount(prev=>a.some(x=>x.id===prev)?prev:(a.some(x=>x.id===localStorage.getItem('archive-account'))?localStorage.getItem('archive-account')||'':a[0]?.id||''));setAccountsReady(true)}).catch(e=>setNotice(String(e)))},[])
 useEffect(()=>{document.documentElement.dataset.theme=theme;localStorage.setItem('theme',theme);window.archive.theme(theme).catch(e=>setNotice(String(e)))},[theme])
 useEffect(()=>{generation.current++;const target=pendingLocate.current?.account===account?pendingLocate.current:null;pendingLocate.current=null;if(account)localStorage.setItem('archive-account',account);setChat(target?.chat||'');setHighlight(target?.rowid||0);setMessages([]);setResults([]);setOffset(target?.offset||0);setSearching(false);setFilter('');setSessions([]);setSessionStatus('loading')},[account])
 useEffect(()=>{
  const id=++request.current
  const priorLive=liveApplied.current
  setPendingLatest(false);setMessages([]);setMoreHistory(false);setLoadingOlder(false)
  scrollTarget.current=null
  if(page!=='chat'||!account||!chat)return
  void window.archive.messages({account,chat,offset}).then(rows=>{
   if(id!==request.current||liveApplied.current!==priorLive)return
   scrollTarget.current='bottom'
   setMessages(rows);setMoreHistory(rows.length===100)
  }).catch(e=>{if(id===request.current)setNotice(String(e))})
  return()=>{request.current++}
 },[account,chat,offset,reload,page])
 useEffect(()=>{
  if(!liveRevision||!account||!chat||page!=='chat')return
  if(offset||highlight||searching){setPendingLatest(true);return}
  const view=request.current
  let current=true
  void window.archive.messages({account,chat}).then(rows=>{
   if(!current||view!==request.current||!rows.length)return
   const list=messageList.current
   const pinned=!list||list.scrollHeight-list.scrollTop-list.clientHeight<72
   const visible=list&&Array.from(list.children).find(el=>el.getBoundingClientRect().bottom>list.getBoundingClientRect().top)
   const existing=list&&new Set(Array.from(list.children,el=>el.id))
   const overlaps=rows.some(row=>existing?.has('message-'+row.rowid))
   if(!pinned&&!overlaps){setPendingLatest(true);return}
   liveApplied.current=liveRevision
   setPendingLatest(false)
   if(pinned)scrollTarget.current='bottom'
   else if(visible&&list)scrollTarget.current={anchor:visible.id,offset:visible.getBoundingClientRect().top-list.getBoundingClientRect().top}
   if(!overlaps)setMoreHistory(rows.length===100)
   setMessages(previous=>{
    if(!overlaps)return rows
    const merged=new Map(previous.map(row=>[row.rowid,row]))
    for(const row of rows)merged.set(row.rowid,row)
    return [...merged.values()].sort((a,b)=>a.ts-b.ts||a.rowid-b.rowid)
   })
  }).catch(e=>{if(current&&view===request.current)setNotice(String(e))})
  return()=>{current=false}
 },[liveRevision])
 useLayoutEffect(()=>{
  const list=messageList.current,target=scrollTarget.current
  if(!list||!target)return
  scrollTarget.current=null
  if(target==='bottom'){
   const located=highlight&&document.getElementById('message-'+highlight)
   if(located)located.scrollIntoView({block:'center'})
   else list.scrollTop=list.scrollHeight
  }else if('anchor' in target){
   const anchor=document.getElementById(target.anchor)
   if(anchor)list.scrollTop+=anchor.getBoundingClientRect().top-list.getBoundingClientRect().top-target.offset
  }else list.scrollTop=target.top+list.scrollHeight-target.height
 },[messages,highlight])
 useLayoutEffect(markTraceDOM,[messages,page,chat,searching])
 const loadOlder=async()=>{
  const first=messages[0],id=request.current
  if(!first||!moreHistory||olderInFlight.current===id)return
  olderInFlight.current=id
  setLoadingOlder(true)
  try{
   const rows=await window.archive.messages({account,chat,before:{ts:first.ts,rowid:first.rowid}})
   if(id!==request.current)return
   const list=messageList.current
   if(list)scrollTarget.current={height:list.scrollHeight,top:list.scrollTop}
   setMoreHistory(rows.length===100)
   setMessages(current=>{
    const ids=new Set(current.map(row=>row.rowid))
    return [...rows.filter(row=>!ids.has(row.rowid)),...current]
   })
  }catch(e){if(id===request.current)setNotice(String(e))}
  finally{
   if(olderInFlight.current===id)olderInFlight.current=null
   if(id===request.current)setLoadingOlder(false)
  }
 }
 const importArchive=()=>run(async()=>{const r=await window.archive.importArchive();if(!r)return;const a=await window.archive.accounts();setAccounts(a);if(!account)setAccount(a[0]?.id||'');else await refresh(account);setNotice(`已导入 ${r.added} 条新消息；重复消息未覆盖。`)})
 const find=()=>run(async()=>{const token=generation.current;const a=account;const r=await window.archive.find({account:a,query});if(token!==generation.current)return;setResults(r);setSearching(true);setPage('chat')})
 const locate=(m:{rowid:number;account?:string})=>run(async()=>{const a=m.account||account,p=await window.archive.locate({account:a,rowid:m.rowid});if(a!==account){pendingLocate.current={...p,account:a};setAccount(a)}else{setChat(p.chat);setOffset(p.offset);setHighlight(p.rowid);setReload(n=>n+1)}setSearching(false);setPage('chat')})
 const favorite=(m:Message)=>run(async()=>{const saved=!m.favorited;await window.archive.saveFavorite({account:m.account,rowid:m.rowid,saved});setMessages(rows=>rows.map(row=>row.account===m.account&&row.rowid===m.rowid?{...row,favorited:saved}:row));setNotice(saved?'已加入 Memory Weave 本地收藏。':'已取消本地收藏。')})
 const openChat=(id:string)=>{setChat(id);setOffset(0);setHighlight(0);setSearching(false);setPage('chat')}
 const undo=(m:Message)=>run(async()=>{await window.archive.undo({account,rowid:m.rowid});await refresh(account);setMessages(await window.archive.messages({account,chat,offset}));setNotice('已撤销一次本地修改。')})
 const save=()=>run(async()=>{if(!edit)return;await window.archive.edit({account,rowid:edit.rowid,text:edit.localText??null,note:edit.note,ts:edit.ts,hidden:!!edit.hidden});setEdit(null);await refresh(account);setMessages(await window.archive.messages({account,chat,offset}));setNotice('已保存到工作库，源归档未改动。')})
 const doExport=()=>run(async()=>{const r=await window.archive.exportArchive({account,chat:page==='chat'?chat:undefined,format});if(r)setNotice(`已实际导出 ${r.count} 条消息。`)})
 const empty=(title:string,detail:string,action=false)=><div className="empty"><div className="empty-mark"><Icon name={navigation.find(n=>n[0]===page)?.[2]||'box'}/></div><h2>{title}</h2><p>{detail}</p>{action&&<button className="primary" onClick={importArchive} disabled={busy}>导入聊天归档</button>}</div>
 const unavailable:Record<string,[string,string]>={moments:['朋友圈适配尚未实现','需要独立适配用户授权的朋友圈数据后，才能提供时间线和日历。'],annual:['年度报告尚未实现','待统一数据适配与统计验证完成后生成年度报告和双人关系报告。'],advanced:['高级能力开发状态','本地副本编辑已可用：双击消息即可修改文字、显示时间、备注或隐藏，并可在“其他资料”撤销。微信发送、公众号文章导出和媒体补齐尚未实现。'],ai:['AI 助手尚未接通','模型管理、RAG、OCR、语音转录及自动化任务尚未实现。当前搜索是关键词搜索，不会伪装为语义搜索。']}
 return <MediaRevisions.Provider value={mediaRevisions}><div className="window"><header className="titlebar"><span className="brand">Memory Weave Next</span><button aria-label={collapsed?'展开导航':'折叠导航'} aria-expanded={!collapsed} onClick={()=>setCollapsed(value=>!value)}><Icon name="panel"/></button><span className="build-label">个人本地档案 · 开发预览 0.3.9 Next</span></header><div className={'shell '+(collapsed?'collapsed':'')}><aside><nav>{navigation.map(([id,label,icon])=><button key={id} title={label} aria-current={page===id?'page':undefined} onClick={()=>{setPage(id);setSearching(false);if(id==='chat')setReload(n=>n+1)}}><Icon name={icon}/><span>{label}</span></button>)}</nav><footer>{sync&&<button title="微信同步状态" aria-expanded={showSync} onClick={()=>setShowSync(value=>!value)}><Icon name="download"/><span>{sync.state==='done'?(sync.integrityIssues?'来源待核对':'已同步'):sync.state==='partial'?'部分成功':sync.state==='authorization'?'需要授权':sync.state==='paused'?'同步已暂停':sync.state==='error'?'同步遇到问题':sync.state==='cancelled'?'同步已取消':'后台同步'}</span></button>}<button title="应用锁尚未实现" disabled><Icon name="lock"/><span>应用锁 · 未实现</span></button><button aria-current={page==='settings'?'page':undefined} onClick={()=>setPage('settings')} title="设置"><Icon name="settings"/><span>设置</span></button><div className="account"><div className="avatar">{accounts.find(a=>a.id===account)?.name.slice(0,1)||'本'}</div><div className="account-switch"><select aria-label="切换账号" title="切换账号" value={account} onChange={e=>setAccount(e.target.value)}>{!accounts.length&&<option value="">未导入账号</option>}{accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select><small>{account?'本地归档已连接':'等待授权归档'}</small></div></div></footer></aside><main>{notice&&<div role="status" className="notice">{notice}<button onClick={()=>setNotice('')} aria-label="关闭提示">×</button></div>}
 {page==='chat'?<div className="chat-layout"><section className="conversations"><div className="list-search"><Icon name="search"/><input aria-label="筛选会话" placeholder="搜索联系人" value={filter} onChange={e=>setFilter(e.target.value)}/></div><div className="contact-scroll">{filteredSessions.map(c=><button className={'contact '+(chat===c.id&&!searching?'selected':'')} key={c.id} onClick={()=>{setChat(c.id);setOffset(0);setSearching(false);setHighlight(0)}}><Avatar key={account+c.id} account={account} id={c.id} name={c.name}/><div className="contact-copy"><div className="contact-heading"><strong title={c.name}>{c.name}</strong>{c.latest!=null&&<time title={date(c.latest)} dateTime={new Date(c.latest*1000).toISOString()}>{latestLabel(c.latest)}</time>}</div><small className="contact-preview">{c.preview||(c.latest?'已归档消息':'等待近期消息')}</small></div></button>)}{!sessions.length&&<p className="muted padded">{sessionStatus==='error'?'会话列表加载失败':sessionStatus==='loading'&&account?'正在加载会话…':'尚无会话'}</p>}</div></section><section className="chat-content"><div className="masthead"><strong>{searching?'全局搜索':current?.name||'聊天'}</strong><form onSubmit={e=>{e.preventDefault();void find()}}><input aria-label="搜索聊天记录" placeholder="搜索全部聊天记录" value={query} onChange={e=>setQuery(e.target.value)}/><button title="执行关键词搜索" disabled={!account||busy||!query.trim()}><Icon name="search"/></button></form><button title="导出当前会话" disabled={!chat||busy} onClick={()=>{setPage('export')}}><Icon name="download"/></button>{chat&&!searching&&account.startsWith('wechat:')&&<button className="media-retry" onClick={()=>{void traceAction(trace?'status':'start')}}>{trace?'查看更新诊断':'跟踪下一条更新'}</button>}</div>{trace&&<div className="trace-strip" role="status"><span>匿名诊断 · 5 分钟内有效 · T0 需手动标记</span>{['t0','t1','t2','t3','t4','t5','t6'].map(k=><small key={k}>{k.toUpperCase()} {typeof trace.points[k]==='number'?new Date(Number(trace.points[k])).toISOString().slice(11,23)+' UTC':'—'}</small>)}{trace.points.failure&&<small>{trace.points.failure}</small>}<button className="media-retry" onClick={()=>{void traceAction('seen')}}>我已在微信看到测试消息</button><button className="media-retry" onClick={()=>{void traceAction('stop')}}>结束</button></div>}{searching?<div className="results"><p className="muted">找到 {results.length} 条结果（最多 100 条） · 点击定位原消息</p>{results.map(m=><button className="result" key={m.rowid} onClick={()=>locate(m)}><small>{m.chatName} · {m.sender} · {date(m.ts)}</small><p>{m.displayContent}</p></button>)}</div>:!chat?sessions.length?empty('选择一个聊天，查看历史消息',''):canImport?empty('你的聊天，留在本机','可导入授权归档，也可在设置中连接本机微信。',true):empty(sessionStatus==='error'?'会话列表加载失败':'正在加载会话…',''):<><div className="pagination"><button disabled={busy||loadingOlder||!moreHistory} onClick={()=>void loadOlder()}>{loadingOlder?'正在加载…':'加载更早消息'}</button><small>{pendingLatest?'有新消息 · 可回到最新':offset?'定位到历史消息':'从最新一页打开 · 向上加载历史'}</small><button disabled={busy} onClick={()=>{setOffset(0);setHighlight(0);setReload(n=>n+1)}}>回到最新</button></div><div className="messages" ref={messageList} onScroll={event=>{markTraceDOM();if(event.currentTarget.scrollTop<50)void loadOlder()}}>{messages.map(m=><div id={'message-'+m.rowid} key={m.rowid} className={'message '+(m.outgoing?'out':'in')+(highlight===m.rowid?' highlighted':'')}><Avatar key={account+m.sender} account={account} id={m.sender} name={m.senderName||m.sender}/><div className="message-copy"><small>{m.senderName||m.sender} · {date(m.ts)}</small><div className="bubble" tabIndex={0} title="双击或按回车编辑本地副本" onDoubleClick={()=>setEdit({...m})} onKeyDown={event=>{if(event.target===event.currentTarget&&event.key==='Enter')setEdit({...m})}}><MessageBody key={m.contentData.type} content={m.contentData} account={m.account} rowid={m.rowid}/></div>{m.note&&<small>备注：{m.note}</small>}<button className="edit-tag" disabled={busy} onClick={()=>void favorite(m)}>{m.favorited?'取消收藏':'收藏'}</button>{!!m.edited&&<button className="edit-tag" onClick={()=>undo(m)}>本地已修改 · 撤销</button>}</div></div>)}</div><div className="composer-disabled"><Icon name="lock"/><span>仅浏览本地归档 · 微信消息发送尚未实现</span></div></>}</section></div>:
 page==='contacts'?<Directory key={account} account={account} revision={sync?.state==='done'?sync.id:0} Avatar={Avatar} onChat={openChat}/>:
 page==='analytics'?<Analysis key={account} account={account} sessions={sessions} revision={sync?.state==='done'?sync.id:0} locate={m=>void locate(m)}/>:
 page==='diagnostics'?<Diagnostics account={account} revision={sync?.state==='done'?sync.id:0}/>:
 page==='favorites'||page==='media'?<ArchiveList key={page+account} mode={page} account={account} sessions={sessions} locate={m=>void locate(m)}/>:
 page==='other'?<><div className="masthead"><h2>本地修改记录</h2><span className="muted">原始归档保留不变</span></div><div className="results">{changes.map(m=><div className="change" key={m.rowid}><small>{m.sender} · {date(m.ts)} {m.hidden?' · 已隐藏':''}</small><p>{m.displayContent}</p><button onClick={()=>undo(m)} disabled={busy}>撤销上次修改</button></div>)}{!changes.length&&empty('尚无本地修改','双击聊天消息可编辑独立工作库中的副本。')}</div></>:
 page==='export'?<><div className="masthead"><h2>导出中心</h2><span className="muted">导出当前账号的有效消息，不含已隐藏内容</span></div><div className="settings"><h3>聊天记录导出</h3><label>导出格式<select value={format} onChange={e=>setFormat(e.target.value)}><option value="json">JSON · 结构化有效消息</option><option value="md">Markdown · 离线阅读</option></select></label><p className="muted">当前实现导出该账号全部消息；导出中的本地修改、备注和原文均保留。附件、定时及增量导出尚未实现。</p><button className="primary" onClick={doExport} disabled={!account||busy}>选择保存位置并导出</button></div></>:
 page==='settings'?<div className="prefs-page"><WeChatConnection/><details className="prefs-extra"><summary>外观</summary><label>主题<select value={theme} onChange={e=>setTheme(e.target.value)}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label></details><details className="prefs-extra"><summary>归档导入</summary><p>从授权的 JSON 归档导入聊天记录。</p><button className="outline-button" onClick={importArchive} disabled={busy}>导入聊天归档</button></details><details className="prefs-extra"><summary>关于开发预览</summary><p>工作库尚未加密。应用锁、自动获取数据库密钥、HTTP / MCP 尚未接入。数据只在本机处理。</p></details></div>:
 page==='ai'?<AIPage key={account} account={account} onLocate={m=>{void locate(m)}}/>:unavailable[page]?empty(...unavailable[page]):null}
 {sync&&sync.account===account&&sync.state!=='done'&&<div className="sync-scope">当前浏览、搜索与统计仅包含已同步的记录。</div>}
 </main></div>{sync&&showSync&&<section className="sync-card" aria-label="后台同步进度"><div className="sync-heading"><strong>微信同步</strong><button aria-label="收起同步卡片" onClick={()=>setShowSync(false)}>×</button></div><div role="status">{sync.state==='paused'?'已请求暂停，当前批次收尾后停止':sync.state==='cancelling'?'正在停止':sync.stage}</div>{sync.file&&sync.state==='running'&&<small>{sync.file}</small>}<p>累计扫描 {(sync.scanned||0).toLocaleString()} 条 · 本次扫描 {Math.max(0,(sync.scanned||0)-(sync.checkpointScanned||0)).toLocaleString()} 条 · 本次新增 {(sync.added||0).toLocaleString()} 条{sync.deduplicated!==undefined?` · 本次去重 ${sync.deduplicated.toLocaleString()} 条`:''}{sync.skipped?` · 跳过 ${sync.skipped} 条`:''}{sync.state==='running'&&sync.speed?` · 约 ${sync.speed.toLocaleString()} 条/秒`:''}</p>{(sync.batchSize||sync.errors)?<p>当前批次上限 {sync.batchSize||0} 条 · 查询错误 {sync.errors||0} 次</p>:null}{sync.totalTables? <><progress aria-label="当前阶段分表进度" value={sync.doneTables||0} max={sync.totalTables}/><small>当前阶段已完成 {sync.doneTables||0} / {sync.totalTables} 个分表</small></> : sync.state==='running'&&<progress aria-label="正在准备或加载预览"/>}{!!sync.failedTables&&<p>{sync.failedTables} 个分表保留断点，等待重试</p>}{sync.pendingShards?.map(item=><p key={item.sourceId+item.phase}><code>{item.sourceId}</code> · {item.phase} · {item.kind==='SOURCE_CHANGED'?'SHARD_CHANGED':item.kind}</p>)}{sync.incremental&&<small>正常分表检查：{sync.lastNormalCheck?new Date(sync.lastNormalCheck).toLocaleString():'—'} · 最近新消息提交：{sync.lastCommit?new Date(sync.lastCommit).toLocaleString():'—'} · 全分表通过：{sync.lastSuccess?new Date(sync.lastSuccess).toLocaleString():'—'}</small>}{sync.completedSessions!==undefined&&<p>已加载 {sync.completedSessions} 个会话分表</p>}{sync.warnings?.map(w=><p key={w}>{w}</p>)}<div className="sync-actions">{sync.state==='running'&&<button onClick={()=>syncAction('paused')}>暂停</button>}{sync.state==='paused'&&<button onClick={()=>syncAction('running')}>继续</button>}{['running','paused'].includes(sync.state)&&<button onClick={()=>syncAction('cancelled')}>取消任务</button>}{['error','partial','cancelled'].includes(sync.state)&&<button onClick={retrySync}>从断点重试</button>}</div></section>}{busy&&<div className="busy" role="status">正在处理本地数据…</div>}{edit&&<div className="modal-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="edit-title" className="modal"><h2 id="edit-title">编辑本地副本</h2><p className="muted">不会修改微信数据库和源归档文件。</p><label>消息文字<textarea value={edit.localText??edit.contentData.text??''} placeholder={edit.contentData.type==='text'?undefined:'可输入一段本地替代文字'} onChange={e=>setEdit({...edit,localText:e.target.value})}/></label><label>备注<input value={edit.note} onChange={e=>setEdit({...edit,note:e.target.value})}/></label><label>显示时间（Unix 秒）<input type="number" value={edit.ts} onChange={e=>setEdit({...edit,ts:Number(e.target.value)})}/></label><label className="checkbox"><input type="checkbox" checked={!!edit.hidden} onChange={e=>setEdit({...edit,hidden:Number(e.target.checked)})}/>隐藏此消息（可在其他资料中撤销）</label><div className="modal-actions"><button onClick={()=>setEdit(null)} disabled={busy}>取消</button><button className="primary" onClick={save} disabled={busy}>保存本地修改</button></div></section></div>}</div></MediaRevisions.Provider>
}
createRoot(document.getElementById('root')!).render(<App/> )
