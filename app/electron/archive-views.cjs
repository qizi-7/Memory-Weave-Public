const {messageContent,buildMessagePreview}=require('./message-content.cjs');
const collator=new Intl.Collator('zh-u-co-pinyin');
const initials='ABCDEFGHJKLMNOPQRSTWXYZ';
const boundaries=Array.from('阿芭擦搭蛾发噶哈击喀垃妈拿哦啪期然撒塌挖昔压匝');
function initial(name){
 const ch=Array.from(name.trim())[0]||'';
 if(/^[a-z]$/i.test(ch))return ch.toUpperCase();
 if(!/\p{Script=Han}/u.test(ch))return '#';
 for(let i=boundaries.length-1;i>=0;i--)if(collator.compare(ch,boundaries[i])>=0)return initials[i];
 return 'A';
}
function str(value){if(typeof value!=='string'||value.length>1000)throw Error('筛选参数无效');return value}
function size(n=50){if(!Number.isInteger(n)||n<1||n>100)throw Error('分页大小无效');return n}
function num(value){if(!Number.isSafeInteger(value)||value<0)throw Error('数字参数无效');return value}
function filter(a,alias='e'){
 const where=[alias+'.hidden=0'],params=[];
 const add=(sql,value)=>{where.push(sql);params.push(value)};
 if(a.account)add(alias+'.account=?',str(a.account));
 if(a.chat){if(!a.account)throw Error('请先选择账号');add(alias+'.chat=?',str(a.chat))}
 if(a.from!=null)add(alias+'.ts>=?',num(a.from));
 if(a.to!=null)add(alias+'.ts<?',num(a.to));
 if(a.from!=null&&a.to!=null&&a.from>=a.to)throw Error('起始时间必须早于结束时间');
 return {where,params,add};
}
function preview(row){
 const {text,kind,...rest}=row;
 return {...rest,kind,preview:buildMessagePreview(messageContent({text,kind}))};
}
const projection='e.rowid,e.account,e.chat,e.ts,e.kind,substr(e.text,1,262145) text,COALESCE(c.name,e.chat) chatName';
class ArchiveViews{
 constructor(db,{persist=true}={}){this.db=db;this.persist=persist;this.cache=new Map();this.version=null}
 cached(key,fn){
  const version=this.db.prepare('PRAGMA data_version').get().data_version;
  if(this.version!==version){this.version=version;this.cache.clear()}
  if(this.cache.has(key))return this.cache.get(key);
  const result=fn();if(this.cache.size>=12)this.cache.delete(this.cache.keys().next().value);this.cache.set(key,result);return result;
 }
 snapshot(fn){this.db.exec('BEGIN');try{return fn()}finally{this.db.exec('ROLLBACK')}}
 has(name){return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)}
 directory(a){
  const account=str(a.account),limit=size(a.limit),offset=num(a.offset??0),query=str(a.query??'').trim().toLocaleLowerCase();
  const all=this.cached('contacts:'+account,()=>this.db.prepare(`SELECT c.id,c.name,
    (SELECT m.ts FROM messages m LEFT JOIN edits e ON e.message=m.rowid WHERE m.account=c.account AND m.chat=c.id AND COALESCE(e.hidden,0)=0 ORDER BY m.ts DESC,m.rowid DESC LIMIT 1) latest
    FROM contacts c WHERE c.account=?`).all(account).map(c=>({...c,group:initial(c.name)})).sort((a,b)=>(Number(a.group==='#')-Number(b.group==='#')||a.group.localeCompare(b.group))||collator.compare(a.name,b.name)||a.id.localeCompare(b.id)));
  const withChats=all.filter(c=>c.latest!==null).length;
  const matching=all.filter(c=>(!a.withChats||c.latest!==null)&&(!query||c.name.toLocaleLowerCase().includes(query)||c.id.toLocaleLowerCase().includes(query)));
  return {total:all.length,withChats,matched:matching.length,items:matching.slice(offset,offset+limit)};
 }
 diagnostics(account){
  account=str(account??'');
  return this.cached('diagnostics:'+account,()=>this.snapshot(()=>{
   const db=this.db;
   const counts=id=>{
    const hasAccount=id!==null,where=hasAccount?' WHERE account=?':'',params=hasAccount?[id]:[];
    const count=t=>db.prepare('SELECT count(*) n FROM '+t+where).get(...params).n;
    // Step through the existing account/chat index; do not read message bodies.
    const sessions=hasAccount?db.prepare(`WITH RECURSIVE seen(chat) AS (
     SELECT (SELECT chat FROM messages WHERE account=? ORDER BY chat LIMIT 1)
     UNION ALL SELECT (SELECT chat FROM messages WHERE account=? AND chat>seen.chat ORDER BY chat LIMIT 1) FROM seen WHERE chat IS NOT NULL
    ) SELECT count(*) n FROM (SELECT chat FROM seen WHERE chat IS NOT NULL UNION SELECT chat FROM session_catalog WHERE account=?)`).get(id,id,id).n:
     db.prepare('SELECT count(*) n FROM (SELECT account,chat FROM messages GROUP BY account,chat UNION SELECT account,chat FROM session_catalog)').get().n;
    return {messages:count('messages'),contacts:count('contacts'),sessions};
   };
   const accounts=db.prepare('SELECT id FROM accounts').all();
   const selected=accounts.some(a=>a.id===account);
   const scope=(t,extra='')=>this.has(t)&&selected?db.prepare('SELECT count(*) n FROM '+t+' WHERE account=?'+extra).get(account).n:null;
   const checkpoints=scope('wechat_sync_cursor'),completed=scope('wechat_sync_cursor',' AND done=1'),gaps=scope('wechat_sync_gaps',' AND resolved_at IS NULL'),pending=scope('wechat_sync_retry',' AND resolved_at IS NULL'),window=scope('wechat_sync_window');
   const sync=!selected?'unselected':gaps||pending?'gaps':window||checkpoints>completed?'incomplete':checkpoints&&checkpoints===completed?'recorded-complete':'unknown';
   const current=selected?counts(account):null;
   return {accounts:accounts.length,workspace:accounts.length===1&&current?current:counts(null),current,checkpoints,completed,gaps,pending,sync};
  }));
 }
 stats(a){
  if(!require('./archive-projection.cjs').projectionReady(this.db))throw Error('统计索引尚未完成，请在应用内重试。');
  const key=JSON.stringify(['stats',a.account||null,a.chat||null,a.from??null,a.to??null,Intl.DateTimeFormat().resolvedOptions().timeZone]);
  const {where,params}=filter(a);
  const statsIndex=!a.account&&(a.from!=null||a.to!=null)?'archive_facts_range':'archive_facts_scope';
  const from=' FROM archive_facts e INDEXED BY '+statsIndex+' WHERE '+where.join(' AND ');
  const revision=this.db.prepare('SELECT revision FROM archive_fact_state WHERE id=1').get().revision;
  return this.cached(key+':'+revision,()=>{
   const db=this.db;
   const saved=db.prepare('SELECT value FROM archive_stat_results WHERE key=? AND revision=?').get(key,revision);
   if(saved)return JSON.parse(saved.value);
   const result=this.snapshot(()=>{
    const summary=db.prepare('SELECT count(*) total,count(DISTINCT chat) chats,coalesce(sum(outgoing),0) sent,min(ts) first,max(ts) last'+from).get(...params);
    if(!a.account)summary.chats=db.prepare('SELECT count(*) n FROM (SELECT account,chat'+from+' GROUP BY account,chat)').get(...params).n;
    const hours=db.prepare("SELECT strftime('%H',ts,'unixepoch','localtime') hour,count(*) count"+from+' GROUP BY hour ORDER BY hour').all(...params);
    const months=db.prepare("SELECT strftime('%Y-%m',ts,'unixepoch','localtime') month,count(*) count"+from+' GROUP BY month ORDER BY month DESC LIMIT 120').all(...params).reverse();
    const top=db.prepare(`SELECT t.*,coalesce(c.name,t.chat) name FROM (SELECT account,chat,count(*) count${from} GROUP BY account,chat ORDER BY count DESC,account,chat LIMIT 20) t LEFT JOIN contacts c ON c.account=t.account AND c.id=t.chat`).all(...params);
    return {summary,hours,months,top};
   });
   if(this.persist){db.prepare('INSERT OR REPLACE INTO archive_stat_results VALUES(?,?,?)').run(key,revision,JSON.stringify(result));
   db.exec('DELETE FROM archive_stat_results WHERE rowid NOT IN (SELECT rowid FROM archive_stat_results ORDER BY rowid DESC LIMIT 12)');}
   return result;
  });
 }
 browse(a,mode){
  const {where,params,add}=filter(a),limit=size(a.limit);
  if(a.before!=null){num(a.before);add('e.rowid<?',a.before)}
  if(mode==='media'){
   if(a.kind){if(!['image','video','voice'].includes(a.kind))throw Error('媒体类型无效');add('e.kind=?',a.kind)}
   else where.push("e.kind IN ('image','video','voice')");
  }else if(a.hour!=null){if(!/^([01]\d|2[0-3])$/.test(a.hour))throw Error('小时无效');add("strftime('%H',e.ts,'unixepoch','localtime')=?",a.hour)}
  // Select bounded metadata first, hydrate only the page. Ancient ranges seek a time
  // index; unbounded browsing follows the stable descending rowid cursor.
  const scan=where.map(sql=>sql.replaceAll('e.ts','COALESCE(ed.ts,m.ts)').replaceAll('e.hidden','COALESCE(ed.hidden,0)').replaceAll('e.','m.'));
  const ready=require('./archive-projection.cjs').projectionReady(this.db);
  const source=ready
   ? 'SELECT e.rowid FROM archive_facts e '+((a.from!=null||a.to!=null)?'INDEXED BY '+(a.account?'archive_facts_scope':'archive_facts_range'):'NOT INDEXED')+' WHERE '+where.join(' AND ')
   : `SELECT m.rowid FROM messages m ${a.chat?'INDEXED BY messages_page':'NOT INDEXED'} LEFT JOIN edits ed ON ed.message=m.rowid WHERE ${scan.join(' AND ')}`;
  const rows=this.db.prepare(`WITH page AS MATERIALIZED (
    ${source} ORDER BY ${ready?'e':'m'}.rowid DESC LIMIT ?
   ) SELECT ${projection} FROM page JOIN effective e ON e.rowid=page.rowid
   LEFT JOIN contacts c ON c.account=e.account AND c.id=e.chat ORDER BY e.rowid DESC`).all(...params,limit+1);
  return {items:rows.slice(0,limit).map(preview),next:rows.length>limit?rows[limit-1].rowid:null};
 }
 favorites(a){
  if(!this.has('local_favorites'))return {items:[],next:null};
  const account=str(a.account),q=str(a.query??'').trim(),limit=size(a.limit),offset=num(a.offset??0);
  const where=['f.account=?','e.hidden=0'],params=[account];
  if(a.chat){where.push('e.chat=?');params.push(str(a.chat))}
  if(q){where.push('(instr(lower(e.text),lower(?))>0 OR instr(lower(f.note),lower(?))>0 OR instr(lower(c.name),lower(?))>0)');params.push(q,q,q)}
  const order=a.order==='oldest'?'ASC':'DESC';
  const rows=this.db.prepare(`SELECT ${projection},f.note,f.created_at AS savedAt FROM local_favorites f
   JOIN effective e ON e.account=f.account AND e.id=f.message_id
   LEFT JOIN contacts c ON c.account=e.account AND c.id=e.chat WHERE ${where.join(' AND ')}
   ORDER BY f.created_at ${order},f.message_id ${order} LIMIT ? OFFSET ?`).all(...params,limit+1,offset);
  return {items:rows.slice(0,limit).map(preview),next:rows.length>limit?offset+limit:null};
 }
}
function saveFavorite(db,a){
 const account=str(a.account),rowid=num(a.rowid);
 const row=db.prepare('SELECT id FROM effective WHERE account=? AND rowid=? AND hidden=0').get(account,rowid);
 if(!row)throw Error('原消息已隐藏或不存在');
 db.exec(`CREATE TABLE IF NOT EXISTS local_favorites(account TEXT NOT NULL,message_id TEXT NOT NULL,note TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,
 PRIMARY KEY(account,message_id),FOREIGN KEY(account,message_id) REFERENCES messages(account,id))`);
 if(a.saved===false)db.prepare('DELETE FROM local_favorites WHERE account=? AND message_id=?').run(account,row.id);
 else if(a.saved===true)db.prepare(`INSERT INTO local_favorites(account,message_id,note,created_at) VALUES(?,?,?,?) ON CONFLICT(account,message_id) DO UPDATE SET note=CASE WHEN ? THEN excluded.note ELSE local_favorites.note END`).run(account,row.id,str(a.note??''),Date.now(),Number(a.note!==undefined));
 else throw Error('收藏操作无效');
 return true;
}
module.exports={ArchiveViews,saveFavorite,initial};
