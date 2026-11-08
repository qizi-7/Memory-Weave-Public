import {useEffect,useState} from 'react'
import vocabulary from '../electron/text-emoji-names.json'
export const wechatTextEmojiAliases=Object.freeze({version:2,source:'wechat-text-shortcodes',aliases:Object.freeze(Object.fromEntries(vocabulary.names.map(name=>['['+name+']',name])))})
let cached:Record<string,string>={},pending:Promise<Record<string,string>>|undefined
let copyInstalled=false
function preserveCopy(event:ClipboardEvent){const selection=window.getSelection();if(!selection||!selection.rangeCount)return;const fragment=selection.getRangeAt(0).cloneContents();if(!fragment.querySelector('[data-wechat-shortcode] img'))return;for(const item of Array.from(fragment.querySelectorAll<HTMLElement>('[data-wechat-shortcode]')))item.replaceWith(document.createTextNode(item.dataset.wechatShortcode||''));event.clipboardData?.setData('text/plain',fragment.textContent||'');event.preventDefault()}
function load(){if(!copyInstalled){document.addEventListener('copy',preserveCopy);copyInstalled=true;}return pending??=(window.archive.emojiPack?.()||Promise.resolve({})).then(value=>cached=value).catch(()=>cached)}
export function TextEmoji({text}:{text:string}){
 const [assets,setAssets]=useState(cached),[failed,setFailed]=useState<Record<string,boolean>>({})
 useEffect(()=>{let active=true;void load().then(value=>{if(active)setAssets(value)});const refresh=()=>{pending=undefined;setFailed({});void load().then(value=>{if(active)setAssets(value)})};window.addEventListener('mw-emoji-pack',refresh);return()=>{active=false;window.removeEventListener('mw-emoji-pack',refresh)}},[])
 return <span>{text.split(/(\[[^\]\r\n]{1,12}\])/u).map((part,index)=>Object.hasOwn(wechatTextEmojiAliases.aliases,part)
 ?<span key={index} data-wechat-shortcode={part} data-alias-version={2}>{assets[part]&&!failed[part]?<img src={assets[part]} alt={part} title={part} draggable={false} style={{width:'1.4em',height:'1.4em',verticalAlign:'middle'}} onError={()=>setFailed(v=>({...v,[part]:true}))}/>:part}</span>:part)}</span>
}
export function EmojiPackSettings(){
 const [rights,setRights]=useState(false),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false)
 return <div className="capability-card"><div className="capability-copy"><h4>微信文本表情资源</h4><p>支持 109 个准确名称。未导入合法资源时保留原文，不用 Unicode 替代。</p><label><input type="checkbox" checked={rights} onChange={e=>setRights(e.target.checked)}/>我有权使用所选本地图形资源</label><p role="status">{notice}</p></div><button disabled={!rights||busy} onClick={async()=>{setBusy(true);try{const result=await window.archive.importEmojiPack({rightsConfirmed:rights});if(result){setNotice('已验证并保存 '+Object.keys(result).length+' 个资源');window.dispatchEvent(new Event('mw-emoji-pack'))}}catch{setNotice('资源包格式、授权或图片校验失败。')}finally{setBusy(false)}}}>导入本地资源包</button></div>
}
