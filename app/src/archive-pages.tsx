import {useDeferredValue,useEffect,useState,type ReactNode,type ComponentType} from 'react'

type Item={rowid:number;account:string;chat:string;chatName:string;ts:number;kind:string;preview:string;note?:string;savedAt?:number}
type Person={id:string;name:string;group:string;latest:number|null}
type Counts={messages:number;contacts:number;sessions:number}
type Diagnostic={accounts:number;workspace:Counts;current:Counts|null;checkpoints:number|null;completed:number|null;gaps:number|null;pending:number|null;sync:string;runtimeSync:string|null;sourceAvailable:boolean;mediaLibrary:boolean;imageCache:boolean;imageCode:boolean;mediaCredential:boolean;isolated:boolean}
type Filters={account?:string;chat?:string;from?:number;to?:number;hour?:string}
type PageResult={items:Item[];next:number|null}
type Stats={summary:{total:number;chats:number;sent:number};hours:{hour:string;count:number}[];months:{month:string;count:number}[];top:{account:string;chat:string;name:string;count:number}[]}
export type ArchiveViewsAPI={
 directory(a:{account:string;offset:number;query:string;withChats:boolean}):Promise<{total:number;withChats:number;matched:number;items:Person[]}>
 favorites(a:unknown):Promise<PageResult>;saveFavorite(a:{account:string;rowid:number;saved:boolean;note?:string}):Promise<boolean>
 mediaIndex(a:unknown):Promise<PageResult>;statMessages(a:unknown):Promise<PageResult>;stats(a:Filters & {requestId?:string}):Promise<Stats>;statsCancel(a:{requestId:string}):Promise<boolean>;diagnostics(a:string):Promise<Diagnostic>
}
const time=(ts:number)=>new Date(ts*1000).toLocaleString('zh-CN',{hour12:false})
const fmt=(n:number|null)=>n===null?'未记录':n.toLocaleString()
function useQuery<T>(load:(requestId:string)=>Promise<T>,key:string,cancel?:(requestId:string)=>void){
 const [state,set]=useState<{key:string;value?:T;error?:string}>({key:''}),[retry,setRetry]=useState(0)
 const request=key+':'+retry
 useEffect(()=>{let active=true;const requestId=crypto.randomUUID();void load(requestId).then(value=>{if(active)set({key:request,value})},error=>{if(active)set({key:request,error:error?.message||'工作库查询失败'})});return()=>{active=false;cancel?.(requestId)}},[request])
 return {...(state.key===request?state:{}),reload:()=>setRetry(n=>n+1)}
}
function State({error,loading,empty,retry,loadingText='正在读取本地归档…'}:{error?:string;loading:boolean;empty?:string;retry:()=>void;loadingText?:string}){
 return error?<div className="archive-state" role="alert"><p>{error}</p><button onClick={retry}>重试</button></div>:loading?<p className="archive-state" role="status">{loadingText}</p>:empty?<p className="archive-state">{empty}</p>:null
}
function Page({title,detail,children}:{title:string;detail:string;children:ReactNode}){
 return <section className="archive-page"><div className="masthead"><h2>{title}</h2><span className="muted">{detail}</span></div><div className="archive-scroll">{children}</div></section>
}
export function Directory({account,revision,Avatar,onChat}:{account:string;revision:number;Avatar:ComponentType<{account:string;id:string;name:string}>;onChat:(id:string)=>void}){
 const [query,Q]=useState(''),[withChats,W]=useState(false),[offset,O]=useState(0)
 const term=useDeferredValue(query)
 const {value,error,reload}=useQuery(()=>window.archive.directory({account,query:term,offset,withChats}),JSON.stringify([account,term,offset,withChats,revision]))
 return <Page title="通讯录" detail="仅显示本地归档联系人">
  <div className="archive-controls"><input aria-label="搜索联系人" placeholder="搜索昵称或联系人标识" value={query} onChange={e=>{Q(e.target.value);O(0)}}/><select aria-label="联系人范围" value={String(withChats)} onChange={e=>{W(e.target.value==='true');O(0)}}><option value="false">全部归档联系人</option><option value="true">有可见聊天记录</option></select><button onClick={reload}>刷新</button></div>
  {!account?<p className="archive-state">尚未选择归档账号。</p>:<><State error={error} loading={!value} empty={value&&!value.items.length?'没有符合条件的联系人。':undefined} retry={reload}/>
  {value&&<><p className="muted">全部 {fmt(value.total)} 人 · 有聊天 {fmt(value.withChats)} 人 · 匹配 {fmt(value.matched)} 人</p>
  {value.items.map((c,i)=><div key={c.id}>{(i===0||value.items[i-1].group!==c.group)&&<h3 className="archive-letter">{c.group}</h3>}<div className="archive-row"><Avatar account={account} id={c.id} name={c.name}/><div><strong>{c.name}</strong><small>{c.id}</small><small>{c.latest===null?'没有可见聊天记录':'最近聊天：'+time(c.latest)}</small></div>{c.latest!==null&&<button onClick={()=>onChat(c.id)}>打开聊天</button>}</div></div>)}
  <div className="archive-controls"><button disabled={!offset} onClick={()=>O(Math.max(0,offset-50))}>上一页</button><span>第 {offset/50+1} 页</span><button disabled={offset+50>=value.matched} onClick={()=>O(offset+50)}>下一页</button></div></>}</>}
 </Page>
}
export function Diagnostics({account,revision}:{account:string;revision:number}){
 const {value:d,error,reload}=useQuery(()=>window.archive.diagnostics(account),account+':'+revision)
 const counts=(c:Counts|null)=>c?`消息 ${fmt(c.messages)} · 联系人 ${fmt(c.contacts)} · 会话 ${fmt(c.sessions)}`:'未选中有效归档账号'
 const sync:Record<string,string>={gaps:'有待处理缺口或分表',incomplete:'有未完成检查点','recorded-complete':'现有检查点均已完成，未证明源库全量一致',unknown:'未记录同步状态',unselected:'未选中账号'}
 return <Page title="数据诊断" detail="仅显示匿名计数与可用性"><div className="archive-controls"><button onClick={reload}>刷新诊断</button></div><State error={error} loading={!d} retry={reload}/>{d&&<dl className="archive-diagnostics"><dt>工作库</dt><dd>{d.isolated?'隔离验证':'当前归档'} · {d.accounts} 个账号 · {counts(d.workspace)}</dd><dt>当前账号</dt><dd>{counts(d.current)}</dd><dt>历史同步</dt><dd>{sync[d.sync]}{d.runtimeSync&&' · 当前任务：'+d.runtimeSync}</dd><dt>检查点 / 缺口</dt><dd>{fmt(d.completed)} / {fmt(d.checkpoints)} 已完成 · 未修复缺口 {fmt(d.gaps)} · 待重试 {fmt(d.pending)}</dd><dt>本机媒体</dt><dd>{d.sourceAvailable?'可定位账号目录':'未定位源目录'} · {d.mediaLibrary?'媒体目录存在':'未发现媒体目录'} · {d.imageCache?'图片缓存目录存在':'未发现图片缓存目录'}</dd><dt>解密条件</dt><dd>{d.mediaCredential?'有媒体数据库凭据':'无可用媒体数据库凭据'} · {d.imageCode?'检测到图片缓存码':'未检测到图片缓存码'}。此处不代表单张图片已解密。</dd></dl>}</Page>
}
type Session={id:string;name:string}
function ChatSelect({sessions,value,change}:{sessions:Session[];value:string;change:(v:string)=>void}){
 return <select aria-label="筛选会话" value={value} onChange={e=>change(e.target.value)}><option value="">全部会话</option>{sessions.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select>
}
function TimeRange({from,to,F,T}:{from:string;to:string;F:(s:string)=>void;T:(s:string)=>void}){
 return <><label>起始 <input aria-label="起始日期" type="date" value={from} onChange={e=>F(e.target.value)}/></label><label>结束 <input aria-label="结束日期" type="date" value={to} onChange={e=>T(e.target.value)}/></label></>
}
function bounds(from:string,to:string):Filters{
 const last=to?new Date(to+'T00:00:00'):null
 if(last)last.setDate(last.getDate()+1)
 return {from:from?new Date(from+'T00:00:00').getTime()/1000:undefined,to:last?last.getTime()/1000:undefined}
}
function Rows({value,error,reload,locate,next,back,extra,empty}:{value?:PageResult;error?:string;reload:()=>void;locate:(m:Item)=>void;next:(n:number)=>void;back?:()=>void;extra?:(m:Item)=>ReactNode;empty:string}){
 return <><State error={error} loading={!value} empty={value&&!value.items.length?empty:undefined} retry={reload}/>
 {value?.items.map(m=><div className="archive-row" key={m.account+':'+m.rowid}><div><strong>{m.preview||m.kind}</strong><small>{m.chatName} · {time(m.ts)}</small>{m.note&&<small>备注：{m.note}</small>}</div>{extra?.(m)}<button onClick={()=>locate(m)}>定位原消息</button></div>)}
 {(back||value?.next!=null)&&<div className="archive-controls"><button disabled={!back} onClick={back}>上一页</button><button disabled={value?.next==null} onClick={()=>value?.next!=null&&next(value.next)}>下一页</button></div>}</>
}
export function ArchiveList({mode,account,sessions,locate}:{mode:'favorites'|'media';account:string;sessions:Session[];locate:(m:Item)=>void}){
 const [query,Q]=useState(''),[chat,C]=useState(''),[order,O]=useState('newest'),[kind,K]=useState(''),[from,F]=useState(''),[to,T]=useState(''),[pages,P]=useState<number[]>([]),[action,A]=useState(''),[note,N]=useState<{item:Item;text:string}|null>(null)
 const term=useDeferredValue(query),cursor=pages.at(-1)
 const filters={account,chat,query:term,order,kind,...bounds(from,to),before:cursor,offset:cursor}
 const result=useQuery(()=>!account?Promise.resolve({items:[],next:null}):mode==='favorites'?window.archive.favorites(filters):window.archive.mediaIndex(filters),JSON.stringify([mode,filters]))
 const change=(setter:(s:string)=>void)=>(s:string)=>{setter(s);P([])}
 const save=async(m:Item,saved:boolean,value?:string)=>{A('');try{await window.archive.saveFavorite({account,rowid:m.rowid,saved,note:value});N(null);P([]);result.reload()}catch(e){A(e instanceof Error?e.message:'收藏操作失败')}}
 return <Page title={mode==='favorites'?'本地收藏':'媒体索引'} detail={mode==='favorites'?'Memory Weave 本地收藏 · 与微信收藏独立':'图片、视频和语音记录 · 可定位源消息'}>
 <div className="archive-controls"><ChatSelect sessions={sessions} value={chat} change={change(C)}/>
 {mode==='favorites'?<><input aria-label="搜索收藏" placeholder="搜索正文、会话或备注" value={query} onChange={e=>change(Q)(e.target.value)}/><select aria-label="收藏排序" value={order} onChange={e=>change(O)(e.target.value)}><option value="newest">最近收藏优先</option><option value="oldest">最早收藏优先</option></select></>:<><select aria-label="媒体类型" value={kind} onChange={e=>change(K)(e.target.value)}><option value="">全部媒体类型</option><option value="image">图片</option><option value="video">视频</option><option value="voice">语音</option></select><TimeRange from={from} to={to} F={change(F)} T={change(T)}/></>}
 <button onClick={result.reload}>刷新</button></div>
 {mode==='media'&&<p className="muted">按归档记录倒序。索引只证明消息存在；打开聊天可检查本机媒体能否读取。</p>}
 {action&&<p role="alert">{action}</p>}
 {note&&<form className="archive-controls" onSubmit={e=>{e.preventDefault();void save(note.item,true,note.text)}}><input aria-label="收藏备注" value={note.text} maxLength={1000} onChange={e=>N({...note,text:e.target.value})}/><button>保存备注</button><button type="button" onClick={()=>N(null)}>取消</button></form>}
 <Rows {...result} locate={locate} empty={account?'没有符合条件的记录。':'尚未选择归档账号。'} next={n=>P([...pages,n])} back={pages.length?()=>P(pages.slice(0,-1)):undefined} extra={mode==='favorites'?m=><><button onClick={()=>N({item:m,text:m.note||''})}>备注</button><button onClick={()=>void save(m,false)}>取消收藏</button></>:undefined}/>
 </Page>
}
export function Analysis({account,sessions,revision,locate}:{account:string;sessions:Session[];revision:number;locate:(m:Item)=>void}){
 const [all,A]=useState(false),[chat,C]=useState(''),[from,F]=useState(''),[to,T]=useState(''),[selected,S]=useState<{filter:Filters;label:string}|null>(null)
 const [syncRevision,bumpSync]=useState(0)
 useEffect(()=>{let last=0;return window.archive.onSyncProgress(task=>{if(task.state==='done'||task.ready&&Date.now()-last>5000){last=Date.now();bumpSync(n=>n+1)}})},[])
 const filter={account:all?undefined:account,chat:all?undefined:chat,...bounds(from,to)}
 const result=useQuery(requestId=>!all&&!account?Promise.resolve(null):window.archive.stats({...filter,requestId}),JSON.stringify([all,filter,revision,syncRevision]),requestId=>{void window.archive.statsCancel({requestId}).catch(()=>{})})
 const stats=result.value
 const change=(setter:(s:string)=>void)=>(s:string)=>{S(null);setter(s)}
 const max=Math.max(1,...(stats?.hours.map(x=>x.count)||[]))
 return <Page title="聊天分析" detail="工作库可见消息 · 本机时区">
 <div className="archive-controls"><select aria-label="统计账号范围" value={String(all)} onChange={e=>{A(e.target.value==='true');S(null)}}><option value="false">当前账号</option><option value="true">全部归档账号</option></select>{!all&&<ChatSelect sessions={sessions} value={chat} change={change(C)}/>}<TimeRange from={from} to={to} F={change(F)} T={change(T)}/><button onClick={result.reload}>刷新</button></div>
 <State error={result.error} loading={stats===undefined} loadingText="正在后台统计。首次建立统计索引后会缓存结果；切换页面或筛选会取消旧请求。" retry={result.reload} empty={stats===null?'尚未选择归档账号。':stats?.summary.total===0?'该筛选范围没有可见消息。':undefined}/>
 {!!stats?.summary.total&&<><div className="metrics">{[['消息',stats.summary.total],['有效会话',stats.summary.chats],['发出',stats.summary.sent],['接收',stats.summary.total-stats.summary.sent]].map(([k,v])=><div key={k}><small>{k}</small><strong>{Number(v).toLocaleString()}</strong></div>)}</div>
 <p><button onClick={()=>S({filter,label:'当前筛选的消息'})}>查看对应消息</button></p>
 <h3>24 小时活跃分布</h3><div className="histogram">{Array.from({length:24},(_,h)=>{const hour=String(h).padStart(2,'0'),n=stats.hours.find(x=>x.hour===hour)?.count||0;return <button key={h} title={hour+' 时：'+n+' 条'} onClick={()=>S({filter:{...filter,hour},label:hour+' 时消息'})}><span style={{height:`${Math.max(1,n/max*120)}px`}}/><small>{h}</small></button>})}</div>
 <h3>每月趋势（最多 120 个月）</h3><div className="archive-trend">{stats.months.map(m=><button key={m.month} onClick={()=>{const start=new Date(m.month+'-01T00:00:00'),end=new Date(start);end.setMonth(end.getMonth()+1);S({filter:{...filter,from:Math.max(filter.from??0,start.getTime()/1000),to:Math.min(filter.to??Infinity,end.getTime()/1000)},label:m.month+' 消息'})}}>{m.month} · {fmt(m.count)}</button>)}</div>
 <h3>活跃会话排行</h3>{stats.top.map((c,i)=><div key={c.account+':'+c.chat} className="archive-row"><div><strong>{i+1}. {c.name}</strong><small>{fmt(c.count)} 条</small></div><button onClick={()=>S({filter:{...filter,account:c.account,chat:c.chat},label:c.name})}>查看消息</button></div>)}</>}
 {selected&&<Drilldown key={JSON.stringify(selected)} selection={selected} locate={locate}/>}
 </Page>
}
function Drilldown({selection,locate}:{selection:{filter:Filters;label:string};locate:(m:Item)=>void}){
 const [pages,P]=useState<number[]>([]),before=pages.at(-1)
 const result=useQuery(()=>window.archive.statMessages({...selection.filter,before}),JSON.stringify([selection,before]))
 return <section><h3>{selection.label}</h3><Rows {...result} locate={locate} empty="此范围没有可见消息。" next={n=>P([...pages,n])} back={pages.length?()=>P(pages.slice(0,-1)):undefined}/></section>
}
