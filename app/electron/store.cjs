const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const {messageContent,buildMessagePreview,presentMessage}=require('./message-content.cjs');
class Store {
  constructor(file,{messagesCommitted}={}) {
    this.messagesCommitted=messagesCommitted;
    this.db = new DatabaseSync(file,{timeout:3000});
    if(file!==':memory:')fs.chmodSync(file,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS contacts(account TEXT REFERENCES accounts(id),id TEXT,name TEXT NOT NULL,PRIMARY KEY(account,id));
      CREATE TABLE IF NOT EXISTS session_catalog(account TEXT REFERENCES accounts(id), chat TEXT, PRIMARY KEY(account,chat));
      CREATE TABLE IF NOT EXISTS messages(rowid INTEGER PRIMARY KEY,account TEXT,id TEXT,chat TEXT,sender TEXT,ts INTEGER,text TEXT,outgoing INTEGER,kind TEXT,UNIQUE(account,id));
      CREATE INDEX IF NOT EXISTS messages_page ON messages(account,chat,ts,rowid);
      CREATE TABLE IF NOT EXISTS edits(message INTEGER PRIMARY KEY REFERENCES messages(rowid),text TEXT,note TEXT DEFAULT '',ts INTEGER,hidden INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS revisions(id INTEGER PRIMARY KEY,message INTEGER,previous TEXT,created INTEGER);
      CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(text, tokenize='trigram');
      CREATE VIEW IF NOT EXISTS effective AS SELECT m.rowid,m.account,m.id,m.chat,m.sender,COALESCE(e.ts,m.ts) ts,COALESCE(e.text,m.text) text,m.text original,m.outgoing,m.kind,COALESCE(e.note,'') note,COALESCE(e.hidden,0) hidden, e.message IS NOT NULL edited FROM messages m LEFT JOIN edits e ON e.message=m.rowid;`);
    require('./archive-projection.cjs').installProjection(this.db);
  }
  accounts() { return this.db.prepare('SELECT * FROM accounts ORDER BY name').all(); }
  importFile(file) {
    if(fs.statSync(file).size > 50*1024*1024) throw Error('首版导入上限 50 MB，请按账号或时间拆分。');
    return this.importData(JSON.parse(fs.readFileSync(file,'utf8')));
  }
  importData(data, {maxMessageLength=100000,onCommit,trace}={}) {
    const str = (x,max=1000) => typeof x==='string' && x.length>0 && x.length<=max;
    if(!data || data.version!==1 || !str(data.account?.id) || !str(data.account?.name) || !Array.isArray(data.contacts) || !Array.isArray(data.messages)) throw Error('不是受支持的归档格式，请阅读导入格式文档。');
    const contacts = new Set(); const ids = new Set();
    for(const c of data.contacts) { if(!str(c.id)||!str(c.name)||contacts.has(c.id)) throw Error('联系人字段无效或重复。'); contacts.add(c.id); }
    for(const m of data.messages) {
      if(!str(m.id)||ids.has(m.id)||!contacts.has(m.chat)||!str(m.sender)||typeof m.text!=='string'||m.text.length>maxMessageLength||!Number.isSafeInteger(m.timestamp)||m.timestamp<0||m.timestamp>8640000000000||typeof m.outgoing!=='boolean'||!['text','image','video','voice','file','link','system'].includes(m.kind)) throw Error('消息字段无效、重复或缺少会话联系人。');
      ids.add(m.id);
    }
    const affected=new Set();let added=0,tracedRowid;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO accounts VALUES(?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name').run(data.account.id,data.account.name);
      const c = this.db.prepare('INSERT INTO contacts VALUES(?,?,?) ON CONFLICT(account,id) DO UPDATE SET name=excluded.name WHERE contacts.name IS NOT excluded.name');
      for(const item of data.contacts) c.run(data.account.id,item.id,item.name);
      const insert = this.db.prepare('INSERT INTO messages(account,id,chat,sender,ts,text,outgoing,kind) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(account,id) DO NOTHING');
      const indexMessage=this.db.prepare('INSERT INTO search(rowid,text) VALUES(?,?)');
      for(const m of data.messages) {
        const result=insert.run(data.account.id,m.id,m.chat,m.sender,m.timestamp,m.text,Number(m.outgoing),m.kind);
        if(result.changes) { indexMessage.run(result.lastInsertRowid,m.text); added++; affected.add(m.chat);if(trace&&!tracedRowid)tracedRowid=Number(result.lastInsertRowid); }
      }
      onCommit?.(added);
      this.db.exec('COMMIT');
    } catch(e) { this.db.exec('ROLLBACK'); throw e; }
    if(added&&this.messagesCommitted){
      const revision=this.db.prepare('SELECT revision FROM archive_fact_state WHERE id=1').get().revision;
      this.messagesCommitted({account:data.account.id,chats:[...affected],added,revision,committedAt:Date.now(),...(tracedRowid?{trace:{...trace,rowid:tracedRowid}}:{})});
    }
    return {added,total:data.messages.length};
  }
  contacts(account) {
    return this.db.prepare('SELECT id,name,0 AS count,NULL AS latest FROM contacts WHERE account=? ORDER BY name,id').all(account);
  }
  sessions(account) {
    // Jump between distinct chats in the covering index instead of aggregating message history.
    const list=this.db.prepare(`WITH RECURSIVE archived(chat) AS (
      SELECT (SELECT chat FROM messages WHERE account=? ORDER BY chat LIMIT 1)
      UNION ALL
      SELECT (SELECT m.chat FROM messages m WHERE m.account=? AND m.chat>archived.chat ORDER BY m.chat LIMIT 1)
      FROM archived WHERE archived.chat IS NOT NULL
    ), known AS (
      SELECT chat FROM archived WHERE chat IS NOT NULL
      UNION SELECT chat FROM session_catalog WHERE account=?
    )
    SELECT known.chat AS id,COALESCE(c.name,known.chat) AS name
    FROM known LEFT JOIN contacts c ON c.account=? AND c.id=known.chat`).all(account,account,account,account);
    const preview=this.db.prepare(`SELECT substr(COALESCE(e.text,m.text),1,262145) AS text, m.kind, e.text IS NOT NULL AND e.text IS NOT m.text AS textEdited, m.ts AS latest FROM messages m
      LEFT JOIN edits e ON e.message=m.rowid
      WHERE m.account=? AND m.chat=? AND COALESCE(e.hidden,0)=0
      ORDER BY m.ts DESC,m.rowid DESC LIMIT 1`);
    for(const session of list){
      const row=preview.get(account,session.id);
      session.preview=row?buildMessagePreview(messageContent({...row,kind:row.textEdited?'text':row.kind})):'';
      session.latest=row?.latest??null;
    }
    list.sort((a,b)=>(b.latest??-1)-(a.latest??-1)||a.name.localeCompare(b.name,'zh-Hans')||a.id.localeCompare(b.id));
    return list;
  }
  registerSessions(account,chats) {
    const put=this.db.prepare('INSERT OR IGNORE INTO session_catalog VALUES(?,?)');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      for(const chat of chats)put.run(account,chat);
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  messages({account,chat,offset=0,before}) {
    if(!Number.isSafeInteger(offset)||offset<0) throw Error('分页参数无效');
    if(before&&(!Number.isSafeInteger(before.ts)||!Number.isSafeInteger(before.rowid)))throw Error('历史游标无效');
    const params=before?[account,chat,before.ts,before.rowid,offset]:[account,chat,offset];
    const changed=this.db.prepare(`SELECT 1 FROM edits e CROSS JOIN messages m ON m.rowid=e.message
      WHERE m.account=? AND m.chat=? AND e.ts IS NOT NULL AND e.ts<>m.ts LIMIT 1`).get(account,chat);
    const rows=changed
      ? this.db.prepare(`SELECT * FROM effective WHERE account=? AND chat=? AND hidden=0 ${before?'AND (ts,rowid)<(?,?)':''} ORDER BY ts DESC,rowid DESC LIMIT 100 OFFSET ?`).all(...params)
      : this.db.prepare(`SELECT m.rowid,m.account,m.id,m.chat,m.sender,m.ts,COALESCE(e.text,m.text) text,
          m.text original,m.outgoing,m.kind,COALESCE(e.note,'') note,0 hidden,e.message IS NOT NULL edited
          FROM messages m LEFT JOIN edits e ON e.message=m.rowid WHERE m.account=? AND m.chat=?
          AND COALESCE(e.hidden,0)=0 ${before?'AND (m.ts,m.rowid)<(?,?)':''} ORDER BY m.ts DESC,m.rowid DESC LIMIT 100 OFFSET ?`).all(...params);
    const contact=this.db.prepare('SELECT name FROM contacts WHERE account=? AND id=?');
    const names=new Map();
    return rows.reverse().map(row=>{
      if(!names.has(row.sender))names.set(row.sender,contact.get(account,row.sender)?.name||row.sender);
      return presentMessage({...row,senderName:names.get(row.sender)});
    });
  }
  find({account,query}) {
    if(typeof query!=='string'||query.length>500) throw Error('搜索词无效');
    if(!query.trim()) return [];
    const base='SELECT e.*,c.name chatName FROM effective e LEFT JOIN contacts c ON c.account=e.account AND c.id=e.chat WHERE e.account=? AND e.hidden=0';
    if([...query].length>=3) return this.db.prepare(base+' AND e.rowid IN (SELECT rowid FROM search WHERE search MATCH ?) ORDER BY e.ts DESC LIMIT 100').all(account,'"'+query.replaceAll('"','""')+'"').map(presentMessage);
    return this.db.prepare(base+" AND e.text LIKE ? ESCAPE '\\' ORDER BY e.ts DESC LIMIT 100").all(account,'%'+query.replace(/[\\%_]/g,'\\$&')+'%').map(presentMessage);
  }
  edit({account,rowid,text,note,hidden,ts}) {
    if(!Number.isSafeInteger(rowid)||(text!=null&&(typeof text!=='string'||text.length>100000))||typeof note!=='string'||note.length>10000||typeof hidden!=='boolean'||!Number.isSafeInteger(ts)||ts<0||ts>8640000000000) throw Error('编辑字段无效');
    const message=this.db.prepare('SELECT * FROM messages WHERE rowid=? AND account=?').get(rowid,account);
    if(!message) throw Error('消息不存在');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous=this.db.prepare('SELECT * FROM edits WHERE message=?').get(rowid)||null;
      text??=previous?.text??message.text;
      this.db.prepare('INSERT INTO revisions(message,previous,created) VALUES(?,?,?)').run(rowid,JSON.stringify(previous),Date.now());
      this.db.prepare('INSERT INTO edits(message,text,note,ts,hidden) VALUES(?,?,?,?,?) ON CONFLICT(message) DO UPDATE SET text=excluded.text,note=excluded.note,ts=excluded.ts,hidden=excluded.hidden').run(rowid,text,note,ts,Number(hidden));
      this.db.prepare('DELETE FROM search WHERE rowid=?').run(rowid);
      this.db.prepare('INSERT INTO search(rowid,text) VALUES(?,?)').run(rowid,text);
      this.db.exec('COMMIT'); return true;
    } catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  undo({account,rowid}) {
    const m=this.db.prepare('SELECT * FROM messages WHERE account=? AND rowid=?').get(account,rowid);
    if(!m) throw Error('消息不存在');
    const r=this.db.prepare('SELECT * FROM revisions WHERE message=? ORDER BY id DESC LIMIT 1').get(rowid);
    if(!r) return false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const p=JSON.parse(r.previous);
      this.db.prepare('DELETE FROM edits WHERE message=?').run(rowid);
      if(p) this.db.prepare('INSERT INTO edits VALUES(?,?,?,?,?)').run(rowid,p.text,p.note,p.ts,p.hidden);
      this.db.prepare('DELETE FROM revisions WHERE id=?').run(r.id);
      this.db.prepare('DELETE FROM search WHERE rowid=?').run(rowid);
      this.db.prepare('INSERT INTO search(rowid,text) VALUES(?,?)').run(rowid,p?.text??m.text);
      this.db.exec('COMMIT'); return true;
    } catch(e) {this.db.exec('ROLLBACK');throw e;}
  }
  changes(account) { return this.db.prepare('SELECT * FROM effective WHERE account=? AND edited=1 ORDER BY ts DESC LIMIT 100').all(account).map(presentMessage); }
  mediaMessage({account,rowid}) {
    const row=this.db.prepare('SELECT e.id,e.chat,m.ts,e.kind,e.text,e.original FROM effective e JOIN messages m ON m.rowid=e.rowid WHERE e.account=? AND e.rowid=? AND e.hidden=0').get(account,rowid);
    if (row && ['voice','image','video'].includes(row.kind)) {
      const source=/^(message\/message_\d+\.db):(?:Msg|Chat)_[a-f0-9]{32}:(-?\d+)$/i.exec(row.id);
      if (source) [row.db_relative,row.source_local_id]=source.slice(1);
      if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='wechat_sources'").get()) {
        Object.assign(row,this.db.prepare('SELECT db_relative,source_local_id FROM wechat_sources WHERE account=? AND message_id=?').get(account,row.id));
      }
    }
    return row;
  }
  locate({account,rowid}) {
    const m=this.db.prepare('SELECT * FROM effective WHERE account=? AND rowid=? AND hidden=0').get(account,rowid);
    if(!m) throw Error('原消息已隐藏或不存在');
    const {n}=this.db.prepare('SELECT COUNT(*) n FROM effective WHERE account=? AND chat=? AND hidden=0 AND (ts>? OR (ts=? AND rowid>?))').get(account,m.chat,m.ts,m.ts,rowid);
    return {chat:m.chat,offset:Math.floor(n/100)*100,rowid};
  }
  stats(account) {
    return {summary:this.db.prepare('SELECT COUNT(*) total,COUNT(DISTINCT chat) chats,SUM(outgoing) sent,MIN(ts) first,MAX(ts) last FROM effective WHERE account=? AND hidden=0').get(account),hours:this.db.prepare("SELECT strftime('%H',ts,'unixepoch','localtime') hour,COUNT(*) count FROM effective WHERE account=? AND hidden=0 GROUP BY hour ORDER BY hour").all(account)};
  }
  exportData({account,chat}) {return this.db.prepare('SELECT * FROM effective WHERE account=? AND (? IS NULL OR chat=?) AND hidden=0 ORDER BY ts,rowid').all(account,chat||null,chat||null);}
  close(){this.db.close();}
}
module.exports={Store};
