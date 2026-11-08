const fs = require('node:fs/promises');
const path = require('node:path');
const {pbkdf2,createHash} = require('node:crypto');
const deriveKey = require('node:util').promisify(pbkdf2);
const {createSnapshot} = require('./wechat-snapshot.cjs');
const {keysForDatabases} = require('./wechat-keys.cjs');
const {readQuery} = require('./wechat-adapter.cjs');
const {messageContent} = require('./message-content.cjs');

const quote = value => "'" + String(value).replaceAll("'", "''").replaceAll('\0','') + "'";
const schema = "SELECT name FROM sqlite_master WHERE type='table'";
const blob = value => value?.$hex ? Buffer.from(value.$hex,'hex') : null;

async function openDatabase(root, relative, secret, helper) {
  const snapshot = await createSnapshot(path.join(root,'db_storage'),[relative]).catch(()=>{throw Object.assign(Error('媒体快照无法建立。'),{code:'MEDIA_SNAPSHOT_FAILED'})});
  try {
    const file = path.join(snapshot.root,relative);
    let key;
    try { key=keysForDatabases(secret,false)(relative,file); }
    catch { throw Object.assign(Error('媒体数据库无匹配凭据。'),{code:'MEDIA_KEY_MISMATCH'}); }
    const salt = Buffer.alloc(16);
    const handle = await fs.open(file,'r');
    try { await handle.read(salt); } finally { await handle.close(); }
    for (const mode of ['4','3']) {
      const derived = (await deriveKey(Buffer.from(key,'hex'),salt,mode==='4'?256000:64000,32,mode==='4'?'sha512':'sha1')).toString('hex');
      for (const candidate of [key,derived]) {
        const query = sql => readQuery(helper,file,candidate,mode,sql,{privateCopy:true});
        try {
          await query(schema);
          return {query,key:candidate+salt.toString('hex'),cleanup:snapshot.cleanup};
        } catch (error) {
          if (error.code!=='DB_FORMAT') throw error;
        }
      }
    }
    throw Object.assign(Error('本地媒体数据库密钥或兼容模式不匹配。'),{code:'MEDIA_KEY_MISMATCH'});
  } catch (error) {
    await snapshot.cleanup();
    throw error;
  }
}

// File identity and WAL identity are both part of a cached snapshot generation.
async function mediaStamp(root,relative) {
  const file=path.join(root,'db_storage',relative), values=[];
  for(const target of [file,file+'-wal']) {
    try {
      const stat=await fs.lstat(target,{bigint:true});
      if(!stat.isFile()||stat.isSymbolicLink())throw Object.assign(Error('媒体来源不是普通文件。'),{code:'MEDIA_SNAPSHOT_FAILED'});
      values.push([stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].map(String));
    } catch(error){if(error.code==='ENOENT')values.push(null);else throw error}
  }
  return JSON.stringify(values);
}
function mediaFailure(code) {
  return ({MEDIA_KEY_MISMATCH:'mediaKeyMismatch',NATIVE_TIMEOUT:'mediaQueryTimeout',MEDIA_SNAPSHOT_FAILED:'mediaSnapshotFailed',MEDIA_SCHEMA_UNSUPPORTED:'mediaSchemaUnsupported'})[code]||'mediaDatabaseUnreadable';
}

function wav(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(36+pcm.length,4);
  header.write('WAVEfmt ',8);
  header.writeUInt32LE(16,16);
  header.writeUInt16LE(1,20);
  header.writeUInt16LE(1,22);
  header.writeUInt32LE(16000,24);
  header.writeUInt32LE(32000,28);
  header.writeUInt16LE(2,32);
  header.writeUInt16LE(16,34);
  header.write('data',36);
  header.writeUInt32LE(pcm.length,40);
  return Buffer.concat([header,pcm]);
}

class WeChatMediaDB {
  constructor(helper,{open=openDatabase,stamp=mediaStamp}={}) {
    this.open=open;this.stamp=stamp;this.retiring=new Set();
    this.helper=helper;
    this.databases=new Map();
  }
  async query(root,secret,relative,sql) {
    const id=JSON.stringify([root,relative]);
    const stamp=await this.stamp(root,relative);
    let entry=this.databases.get(id);
    if (entry && (entry.secret!==secret || entry.stamp!==stamp)) {
      this.databases.delete(id);
      const pending=this.retire(id,entry);this.retiring.add(pending);
      void pending.finally(()=>this.retiring.delete(pending)).catch(()=>{});
      entry=undefined;
    }
    if (!entry) {
      entry={secret,stamp,metadata:new Map(),active:0,opened:this.open(root,relative,secret,this.helper)};
      this.databases.set(id,entry);
    }
    clearTimeout(entry.timer);
    entry.active++;
    try {
      const db=await entry.opened.catch(error=>{
        if (this.databases.get(id)===entry) this.databases.delete(id);
        throw error;
      });
      if(sql===schema||/^PRAGMA table_info\([a-z_0-9]+\)$/.test(sql)){
        let result=entry.metadata.get(sql);
        if(!result){result=Promise.resolve().then(()=>db.query(sql));entry.metadata.set(sql,result);result.catch(()=>entry.metadata.delete(sql));}
        return await result;
      }
      return await db.query(sql);
    } finally {
      entry.active--;
      if(!entry.active)for(const resolve of entry.drained?.splice(0)||[])resolve();
      if (!entry.active && this.databases.get(id)===entry) {
        entry.timer=setTimeout(()=>{void this.retire(id,entry).catch(()=>{})},120000);
        entry.timer.unref();
      }
    }
  }
  async retire(id,entry) {
    if(this.databases.get(id)===entry)this.databases.delete(id);
    if(entry.active)await new Promise(resolve=>{(entry.drained??=[]).push(resolve)});
    clearTimeout(entry.timer);
    if (this.databases.get(id)===entry) this.databases.delete(id);
    await (entry.closing??=entry.opened.then(db=>db.cleanup(),()=>{}));
  }
  async verify(root,secret) {
    const dir=path.join(root,'db_storage','message');
    const files=await fs.readdir(dir).catch(()=>[]);
    const paths=[['关联','hardlink/hardlink.db'],['头像','head_image/head_image.db'],...files.filter(n=>/^media_\d+\.db$/.test(n)).sort().map(n=>['语音','message/'+n])];
    if(paths.length===2)paths.push(['语音',null]);
    const entries={},results=[];
    for(const [index,[type,relative]] of paths.entries()){
      let state='missing';
      if(relative)try{
        await fs.lstat(path.join(root,'db_storage',relative));
        const db=await openDatabase(root,relative,secret,this.helper);
        entries[relative]=db.key;
        await db.cleanup();
        state='verified';
      }catch(error){state=error.code==='ENOENT'?'missing':error.code==='MEDIA_KEY_MISMATCH'?'mismatch':'unreadable';}
      results.push({type,index,state});
    }
    return {entries,results};
  }
  async locate(root,secret,row,slot) {
    return (await this.locateDetailed(root,secret,row,slot)).links;
  }
  async locateDetailed(root,secret,row,slot,{sourceSecret}={}) {
    const {type,hashes=[]}=messageContent(row);
    if (!['image','video'].includes(type) || (!hashes.length&&!sourceSecret)) return {links:[],reason:'metadataMissing',stage:'metadata'};
    const chatHash=/^unresolved:[a-f0-9]{32}$/.test(row.chat)?row.chat.slice(11):createHash('md5').update(row.chat).digest('hex');
    const date=new Date(row.ts*1000);
    const directories=type==='image'?[chatHash]:[-1,0,1].map(offset=>{
      const month=new Date(date.getFullYear(),date.getMonth()+offset,1);
      return month.getFullYear()+'-'+String(month.getMonth()+1).padStart(2,'0');
    });
    const tables=await this.query(root,secret,'hardlink/hardlink.db',schema);
    const supported=[4,3].map(v=>`${type}_hardlink_info_v${v}`).filter(t=>tables.some(r=>r.name===t));
    const links=[];let valid=false;
    for(const table of supported){
      const columns=await this.query(root,secret,'hardlink/hardlink.db',`PRAGMA table_info(${table})`);
      if(!['md5','file_name','dir1','dir2'].every(n=>columns.some(c=>c.name===n)))continue;
      valid=true;
      const select=`SELECT h.md5,h.file_name, d.username AS first, e.username AS second
        FROM ${table} h LEFT JOIN dir2id d ON d.rowid=h.dir1 LEFT JOIN dir2id e ON e.rowid=h.dir2
        WHERE h.md5 IN (${hashes.map(quote).join(',')})`;
      const scoped=await this.query(root,secret,'hardlink/hardlink.db',select+` AND h.dir1 IN (SELECT rowid FROM dir2id WHERE username IN (${directories.map(quote).join(',')})) LIMIT 32`);
      const found=scoped.length?scoped:await this.query(root,secret,'hardlink/hardlink.db',select+' LIMIT 32');
      for(const link of found)if(!links.some(r=>r.file_name===link.file_name&&r.first===link.first&&r.second===link.second))links.push(link);
    }
    if(!valid)throw Object.assign(Error('媒体索引结构尚不支持。'),{code:'MEDIA_SCHEMA_UNSUPPORTED'});
    // Resource identifiers are filename identities, not XML content digests. Never
    // use an arbitrary XML hash as a broad filename prefix.
    let resourceFailure;
    if(!links.length && sourceSecret && /^-?\d{1,19}$/.test(String(row.source_local_id)) && Number.isSafeInteger(row.ts)) {
      try {
        const relative='message/message_resource.db';
        const resources=await this.query(root,sourceSecret,relative,`SELECT i.message_id,hex(i.packed_info) AS packed_hex
          FROM MessageResourceInfo i JOIN ChatName2Id n ON n.rowid=i.chat_id
          WHERE n.user_name=${quote(row.chat)} AND i.message_local_id=${quote(row.source_local_id)}
          AND i.message_create_time=${row.ts} AND (i.message_local_type & 4294967295)=${type==='image'?3:43}
          AND length(i.packed_info)=36 LIMIT 2`);
        if(resources.length===1 && /^\d{1,19}$/.test(String(resources[0].message_id))) {
          const packed=Buffer.from(resources[0].packed_hex||'','hex');
          if(packed.length===36 && packed.subarray(0,4).equals(Buffer.from([18,34,10,32]))) {
            const id=packed.subarray(4).toString('ascii');
            if(/^[a-f0-9]{32}$/.test(id) && packed.subarray(4).equals(Buffer.from(id,'ascii'))) {
              const details=await this.query(root,sourceSecret,relative,`SELECT type,size,status FROM MessageResourceDetail WHERE message_id=${quote(resources[0].message_id)} LIMIT 17`);
              // Only the exact, observed resource variants are understood. Unknown
              // types, duplicate variants and incomplete records cannot authorize files.
              const sizes={};
              if(details.length<=16)for(const [role,code] of Object.entries(type==='image'?{thumbnail:262145,original:131073}:{thumbnail:196610,original:131074})) {
                const entries=details.filter(d=>Number(d.type)===code);
                if(entries.length===1 && Number(entries[0].status)===1 && Number.isSafeInteger(Number(entries[0].size)) && Number(entries[0].size)>0)sizes[role]=Number(entries[0].size);
              }
              const month=date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0');
              if(Object.keys(sizes).length)links.push({resource:{id,chatHash,month,sizes}});
            }
          }
        }
      }catch(error){resourceFailure=mediaFailure(error.code);}
    }
    return {links:links.slice(0,32),reason:links.length?null:resourceFailure||'mediaIndexMissing',stage:'index'};
  }

  async avatar(root,secret,username) {
    const rows=await this.query(root,secret,'head_image/head_image.db',
      `SELECT image_buffer FROM head_image WHERE username=${quote(username)} AND length(image_buffer)<=2097152 LIMIT 1`);
    return blob(rows[0]?.image_buffer);
  }
  async voice(root,secret,row) {
    const source=/^message\/message_(\d+)\.db$/.exec(row.db_relative);
    if (!source || !/^-?\d{1,19}$/.test(row.source_local_id) || !Number.isSafeInteger(row.ts)) return null;
    const shards=(await fs.readdir(path.join(root,'db_storage/message'))).filter(name=>/^media_\d+\.db$/.test(name));
    const preferred='media_'+source[1]+'.db';
    shards.sort((a,b)=>Number(b===preferred)-Number(a===preferred));
    let hadReadableShard=false;
    for (const shard of shards) {
      let rows;
      try {
        rows=await this.query(root,secret,'message/'+shard,`SELECT v.voice_data FROM VoiceInfo v JOIN Name2Id n ON n.rowid=v.chat_name_id
          WHERE n.user_name=${quote(row.chat)} AND v.create_time=${row.ts} AND v.local_id=${row.source_local_id}
          AND length(v.voice_data)<=2097152 LIMIT 2`);
        hadReadableShard=true;
      } catch { continue; }
      const data=rows.length===1 && blob(rows[0].voice_data);
      if (!data) continue;
      const {data:decoded}=await require('silk-wasm').decode(data,16000);
      if (!decoded.length) throw Error('SILK 音频无法解码。');
      return wav(Buffer.from(decoded));
    }
    if (!hadReadableShard && shards.length) throw Error('语音数据库不可读。');
    return null;
  }
  async close(root) {
    await Promise.all([...this.databases].filter(([id])=>!root||JSON.parse(id)[0]===root).map(async([id,entry])=>{
      if(this.databases.get(id)===entry)this.databases.delete(id);
      if(entry.active)await new Promise(resolve=>{(entry.drained??=[]).push(resolve)});
      await this.retire(id,entry);
    }));
    await Promise.all([...this.retiring]);
  }
}

module.exports={WeChatMediaDB,mediaStamp,mediaFailure};
