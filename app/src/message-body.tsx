import {TextEmoji} from './text-emoji'
import {createContext,useContext,useEffect,useRef,useState} from 'react'

export const MediaRevisions=createContext<Record<string,number>>({})

export type ContentData = {
 type: 'text' | 'image' | 'video' | 'voice' | 'sticker' | 'file' | 'quote' | 'share' |
 'miniProgram' | 'transfer' | 'system' | 'redPacket' | 'forward' | 'unknown'
 label?: string
 text?: string
 title?: string
 description?: string
 sourceName?: string
 quote?: string
 duration?: number
 bytes?: number
}

function durationLabel(value?: number) {
 if (!value) return ''
 const seconds = Math.max(1,Math.round(value))
 return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`
}

const labels:Record<string,string>={
 metadataMissing:'缺少媒体定位元数据',mediaQueryTimeout:'媒体查询超时',mediaSnapshotFailed:'媒体快照暂不可用',mediaSchemaUnsupported:'媒体索引结构尚不支持',mediaIndexMissing:'媒体索引没有对应记录',mediaKeyMismatch:'媒体凭据不匹配',mediaKeyMissing:'缺少媒体数据库密钥',mediaDatabaseUnreadable:'媒体数据库无法验证或读取',
 sourceUnavailable:'未定位本机微信账号目录',resourceMissing:'本机缺少对应媒体文件',imageKeyMissing:'缺少可用的 V2 图片缓存码',
 decryptFailed:'媒体解密失败',stickerRemoteOnly:'本机没有表情缓存；该消息有网络资源，本应用未访问',frameSizeLimit:'视频较大，未预取封面，可点击播放',videoPreviewMissing:'无缓存封面',formatUnsupported:'本机不支持此媒体格式或文件头无效',decoderUnavailable:'缺少可用的 WXGF 解码器',
 pathRejected:'媒体路径未通过安全校验',filePermission:'本机拒绝读取该文件',fileNotReady:'文件正在变化或尚未写完',fileUnreadable:'本机无法打开或读取文件',imageSizeLimit:'图片超过本地读取上限',decodeFailed:'媒体解码失败',
 readable:'媒体文件存在，但播放器无法解码',voiceUnreadable:'本机语音数据库或解码器不可用'
}
type Identity={account:string;rowid:number;slot?:'preview'|'play'|'frame'}
type MediaPhase='idle'|'pending'|'loaded'|'failed'|'unavailable'
const transient=new Set(['mediaQueryTimeout','mediaSnapshotFailed','fileNotReady','fileUnreadable','mediaDatabaseUnreadable','temporaryFailure'])
const recheckable=new Set(['resourceMissing','stickerRemoteOnly','imageKeyMissing','mediaKeyMissing','sourceUnavailable','mediaIndexMissing','mediaKeyMismatch'])
function useMediaRequest(identity:Identity,initial:MediaPhase) {
 const accountRevision=useContext(MediaRevisions)[identity.account]||0
 const [state,setState]=useState<MediaPhase>(initial),[reason,setReason]=useState('')
 const [generation,setGeneration]=useState(0)
 const token=useRef(0),locked=useRef(false),latestGeneration=useRef(0)
 const bump=()=>setGeneration(++latestGeneration.current)
 const lastRevision=useRef(accountRevision)
 const reset=()=>{
  token.current++;locked.current=false;setReason('');bump();setState(initial)
 }
 useEffect(()=>()=>{token.current++},[])
 useEffect(()=>{
  if(lastRevision.current===accountRevision||state==='pending')return
  lastRevision.current=accountRevision
  if(state==='failed'||state==='unavailable'&&recheckable.has(reason))reset()
 },[accountRevision,state,reason])
 const loaded=()=>{
  if(generation!==latestGeneration.current||locked.current)return
  token.current++;setReason('');setState('loaded')
  void window.archive.mediaOutcome({...identity,render:'shown'}).catch(()=>{})
 }
 const failed=async()=>{
  if(generation!==latestGeneration.current||locked.current)return
  const current=++token.current
  const outcome=await window.archive.mediaOutcome({...identity,render:'failed'}).catch(()=>null)
  if(token.current!==current)return
  const code=outcome||'readable'
  setReason(code);setState(transient.has(code)?'failed':'unavailable')
 }
 const retry=async()=>{
  if(locked.current)return
  locked.current=true
  const current=++token.current
  setReason('');setState('pending')
  try{await window.archive.mediaRetry({account:identity.account,rowid:identity.rowid})}catch{}
  if(token.current!==current)return
  locked.current=false
  bump()
  setState('pending')
 }
 return {state,reason,generation,preparing:locked.current,loaded,failed,retry,setState}
}
function Recovery({state,reason,retry}:{state:MediaPhase;reason:string;retry:()=>void}) {
 const control=(label:string)=><button type="button" className="media-retry" onClick={e=>{e.stopPropagation();retry()}} onDoubleClick={e=>e.stopPropagation()}>{label}</button>
 if(state==='failed')return control('重试')
 if(state!=='unavailable'||!recheckable.has(reason))return null
 return <details className="media-recovery" onDoubleClick={e=>e.stopPropagation()}><summary>更多</summary>{control('重新检查本地文件')}</details>
}
function Preview({url,fallback,identity,onMissing,sticker=false}:{url:string;fallback?:string;identity:Identity;onMissing?:()=>void;sticker?:boolean}) {
 const timingKey='mw-sticker-timing:'+identity.account+':'+identity.rowid
 const [timing,setTiming]=useState(()=>{try{const v=Number(localStorage.getItem(timingKey)||1);return [0.5,1,1.5,2,3].includes(v)?v:1}catch{return 1}})
 const media=useMediaRequest(identity,url?'pending':'unavailable')
 const {state,reason}=media
 const missing=state==='failed'||state==='unavailable'
 return <>
  {missing && fallback && <><span className="message-unavailable">{labels[reason]||fallback}</span><Recovery {...media}/></>}
  {state==='pending' && fallback && <span className="message-unavailable">正在读取本地媒体…</span>}
  {!missing && !media.preparing && <img key={media.generation} className={'message-preview'+(state==='pending'?' pending':'')} src={url+'?rev='+media.generation+'&timing='+(sticker?timing:1)}
    alt={fallback?.replace('暂不可用','')||'视频封面'} loading="lazy"
    onLoad={media.loaded} onError={()=>{void media.failed();onMissing?.()}}/>}
  {sticker&&state==='loaded'&&<details className="media-recovery" onDoubleClick={e=>e.stopPropagation()}><summary>动画速度</summary><p>仅校准本条 WXGF 转码的帧延时，不代表恢复微信原始时间轴。</p><select aria-label="本条动画延时倍数" value={timing} onChange={e=>{const v=Number(e.target.value);setTiming(v);try{localStorage.setItem(timingKey,String(v))}catch{}}}>{[0.5,1,1.5,2,3].map(v=><option key={v} value={v}>{v} 倍帧延时</option>)}</select></details>}
 </>
}

// Decode only visible cards, at most two at once. A paused video paints the first
// decoded frame without copying it to disk, reading canvas pixels, or playing audio.
const frameQueue=new Set<()=>void>()
let frameJobs=0
function drainFrames(){
 while(frameJobs<2&&frameQueue.size){
  const next=frameQueue.values().next().value!
  frameQueue.delete(next)
  next()
 }
}
function FirstFrame({url,identity,onReady}:{url:string;identity:Identity;onReady:()=>void}){
 const host=useRef<HTMLDivElement>(null)
 const [source,setSource]=useState('')
 const [ready,setReady]=useState(false)
 const [reason,setReason]=useState('')
 useEffect(()=>{
  const node=host.current
  if(!node)return
  let held=false,video:HTMLVideoElement|null=null,timer:number|undefined,alive=true,visible=false
  const release=()=>{if(held){held=false;window.clearTimeout(timer);frameJobs--;drainFrames()}}
  const stopVideo=()=>{if(video){video.onloadeddata=null;video.onerror=null;video.removeAttribute('src');video.load();video.remove();video=null}release()}
  const fail=()=>{if(!alive)return;stopVideo();setSource('');setReason('无可用封面，可尝试播放')}
  const start=()=>{
   if(!alive||!visible||video)return
   setReason('');held=true;frameJobs++;video=document.createElement('video')
   video.muted=true;video.playsInline=true;video.preload='auto';video.className='message-frame pending'
   video.setAttribute('aria-label','视频首帧')
   video.onloadeddata=()=>{if(!alive||!video)return;video.pause();video.className='message-frame';setReady(true);onReady();void window.archive.mediaOutcome({...identity,slot:'frame',render:'shown'}).catch(()=>{});release()}
   video.onerror=()=>{video?.remove();fail();void window.archive.mediaOutcome({...identity,slot:'frame',render:'failed'}).then(value=>{if(alive&&visible&&value&&labels[value])setReason(value==='resourceMissing'?'暂未取得首帧，可尝试播放':labels[value])}).catch(()=>{})}
   timer=window.setTimeout(()=>{video?.remove();fail()},6500)
   node.appendChild(video);video.src=url;setSource(url)
  }
  const observer=new IntersectionObserver(entries=>{
   const next=entries.at(-1)?.isIntersecting===true
   if(next===visible)return
   visible=next
   if(next){frameQueue.add(start);drainFrames()}
   else {frameQueue.delete(start);stopVideo();setReady(false);setSource('')}
  },{rootMargin:'100px'})
  observer.observe(node)
  return ()=>{alive=false;observer.disconnect();frameQueue.delete(start);stopVideo()}
 },[url,identity.account,identity.rowid])
 return <><div ref={host}/>{!ready&&reason&&<span className="message-unavailable" title={reason}>封面暂不可用，可尝试播放</span>}{!ready&&source&&!reason&&<span className="message-unavailable">正在读取视频首帧…</span>}</>
}

function Playable({content,url,identity}:{content:ContentData;url:string;identity:Identity}) {
 const media=useMediaRequest({...identity,slot:'play'},'idle')
 const {state,reason,generation}=media
 const [noPoster,setNoPoster]=useState(false)
 const frameReady=useRef(false)
 const video=content.type==='video'
 const duration=durationLabel(content.duration)
 const playUrl=url && url+'/play?rev='+generation
 const playing=state==='pending'||state==='loaded'
 const accountRevision=useContext(MediaRevisions)[identity.account]||0
 useEffect(()=>{if(noPoster&&!frameReady.current)setNoPoster(false)},[accountRevision])
 return <div className={'message-playable'+(video?' message-video-card':'')}>
  <header className="message-media-heading"><span>{video?'视频':'语音'}</span>{duration&&<small>{duration}</small>}</header>
  {video && state==='idle' && url && (noPoster?<FirstFrame url={url+'/frame'} identity={identity} onReady={()=>{frameReady.current=true}}/>:<Preview url={url+'/preview'} identity={identity} onMissing={()=>setNoPoster(true)}/>)}
  {playing && !media.preparing && (video?
    <video key={generation} src={playUrl} controls autoPlay playsInline onLoadedData={media.loaded} onError={media.failed}/>:
    <audio key={generation} src={playUrl} controls autoPlay onLoadedData={media.loaded} onError={media.failed}/>)}
  {state==='pending' && <small className="message-unavailable">正在读取本地媒体…</small>}
  {!playing && <div className="message-media-row">
   <button type="button" className="message-play" aria-label={video?'播放视频':'播放语音'} disabled={state!=='idle'||!playUrl}
    onClick={()=>media.setState('pending')} onDoubleClick={event=>event.stopPropagation()}>▶ {video?'播放视频':'播放语音'}</button>
  </div>}
  {(state==='failed'||state==='unavailable')&&<div className="message-media-error">
   <span role="status">{({resourceMissing:video?'本机没有该视频':'本机没有该语音',mediaKeyMissing:'媒体尚未授权',mediaKeyMismatch:'媒体凭据需重新验证',mediaDatabaseUnreadable:'媒体库暂不可读',mediaQueryTimeout:'媒体查询超时',mediaSnapshotFailed:'媒体快照暂不可用',mediaSchemaUnsupported:'媒体索引结构尚不支持',mediaIndexMissing:'未找到媒体索引',metadataMissing:'缺少媒体定位信息',formatUnsupported:'暂不支持该视频格式',readable:'播放器无法解码'} as Record<string,string>)[reason]||'暂时无法播放'}</span>
   <details className="media-recovery"><summary>更多</summary><small>{labels[reason]||'读取或解码未成功'}</small><button type="button" className="media-retry" onClick={()=>{void media.retry()}} onDoubleClick={e=>e.stopPropagation()}>重新检查本地文件</button></details>
  </div>}

 </div>
}

export function MessageBody({content,account,rowid}:{content:ContentData;account:string;rowid:number}) {
 const url=/^wechat:[0-9a-f]{64}$/.test(account) ? `mw-media://archive/${account.slice(7)}/${rowid}` : ''
 switch (content.type) {
  case 'text': return <TextEmoji text={content.text||'（空内容）'}/>
  case 'image':
  case 'sticker': return <Preview sticker={content.type==='sticker'} key={account+':'+rowid} url={url && url+'/preview'} identity={{account,rowid}} fallback={content.type==='image'?'图片暂不可用':'表情包暂不可用'}/>
  case 'video':
  case 'voice': return <Playable key={account+':'+rowid} content={content} url={url} identity={{account,rowid}}/>
  case 'system':
  case 'unknown': return <span className="message-unavailable">{content.text||content.label}</span>
  default: return <div className="message-card">
   <small>{content.label}{content.sourceName && ' · '+content.sourceName}</small>
   {content.title && <strong>{content.title}</strong>}
   {content.description && <span>{content.description}</span>}
   {content.quote && <blockquote><TextEmoji text={content.quote}/></blockquote>}
   {!!content.bytes && <small>{content.bytes.toLocaleString()} 字节</small>}
  </div>
 }
}
