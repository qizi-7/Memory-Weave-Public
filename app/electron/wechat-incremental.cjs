const crypto=require('node:crypto');
const ident=s=>'"'+s.replaceAll('"','""')+'"';
// A snapshot fingerprint describes bytes, not the lifetime of an append-only table.
// Persist full content digests of both ends, checking identity before reusing a high-water mark.
async function rowProof(query,relative,table,id,schema){
 if(!/^-?\d+$/.test(String(id)))throw Error('增量边界无效。');
 const hash=crypto.createHash('sha256'),cap=Math.max(1,Math.min(65536,Math.floor(262144/schema.length)));
 const fields=schema.flatMap(({name},i)=>[`typeof(${ident(name)}) AS t${i}`,`length(CAST(${ident(name)} AS BLOB)) AS n${i}`,`hex(substr(CAST(${ident(name)} AS BLOB),1,${cap})) AS h${i}`]);
 const [meta]=await query(relative,`SELECT ${fields.join(',')} FROM ${ident(table)} WHERE rowid=${id} LIMIT 1`);
 if(!meta)return null;
 for(let i=0;i<schema.length;i++){
  const name=schema[i].name,n=Number(meta['n'+i]||0);
  if(!Number.isSafeInteger(n)||n<0)throw Object.assign(Error('增量边界长度无效。'),{code:'ANCHOR_BYTES',queryFailure:true});
  hash.update(JSON.stringify([name,meta['t'+i],n]));
  const first=meta['h'+i];
  if(typeof first!=='string'||first.length!==Math.min(cap,n)*2)throw Error('增量边界校验不完整。');
  hash.update(Buffer.from(first,'hex'));
  for(let offset=cap;offset<n;offset+=262144){
   const [row]=await query(relative,`SELECT hex(substr(CAST(${ident(name)} AS BLOB),${offset+1},262144)) AS chunk FROM ${ident(table)} WHERE rowid=${id} LIMIT 1`);
   if(typeof row?.chunk!=='string'||row.chunk.length!==Math.min(262144,n-offset)*2)throw Error('增量边界校验不完整。');
   hash.update(Buffer.from(row.chunk,'hex'));
  }
 }
 return hash.digest('hex');
}
// Only reconcile the existing archive projection; do not change the saved originals.
async function verifyCanonicalPrefix({high,loadPage,readPrior,countPrior,maxRows=100000}){
 const boundary=BigInt(high),expected=countPrior(boundary);
 if(!Number.isSafeInteger(expected)||expected<1||expected>maxRows)return null;
 let after=null,matched=0;
 for(;;){
  const rows=await loadPage(after,128);
  for(const row of rows){
   const id=BigInt(row.__rowid),m=row.message,old=readPrior(String(id));
   if(id>boundary||(after!==null&&id<=after)||String(row.local_id)!==String(id)||!m||!old||
      old.chat!==m.chat||old.text!==m.text||old.ts!==m.timestamp||old.sender!==m.sender||
      old.kind!==m.kind||!!old.outgoing!==m.outgoing||++matched>expected)return null;
   after=id;
  }
  if(rows.length===0)break;
 }
 return after===boundary&&matched===expected?{matched}:null;
}
function openIncremental(db,account){
 db.exec(`CREATE TABLE IF NOT EXISTS wechat_incremental_cursor(account TEXT NOT NULL,source TEXT NOT NULL,fingerprint TEXT NOT NULL,cursor TEXT,first_row TEXT,first_proof TEXT,anchor TEXT,scanned INTEGER NOT NULL,done INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(account,source))`);
 const get=db.prepare('SELECT * FROM wechat_incremental_cursor WHERE account=? AND source=?');
 const put=db.prepare('INSERT OR REPLACE INTO wechat_incremental_cursor VALUES(?,?,?,?,?,?,?,?,?,?)');
 return {get:source=>get.get(account,source),save(source,s){put.run(account,source,s.fingerprint,s.cursor,s.firstRow,s.firstProof,s.anchor,s.scanned,Number(s.done),Date.now())}};
}
module.exports={rowProof,openIncremental,verifyCanonicalPrefix};
