// Synthetic-only benchmark; no production paths, keys, or message bodies are logged.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process'),{performance}=require('node:perf_hooks');
const {DatabaseSync}=require('node:sqlite'),{openBatchReader}=require('../electron/wechat-batch-reader.cjs');
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'mw-native-benchmark-')),file=path.join(root,'synthetic.db');
 const body='\x01'.repeat(3*1024*1024)+'\u2028\u2029';const db=new DatabaseSync(file);db.exec('CREATE TABLE sample(message_content TEXT)');db.prepare('INSERT INTO sample VALUES(?)').run(body);db.close();
 const current=path.resolve('native/.build/wechat-reader'),previous=process.argv[2];
 try{
  const results=[];
  for(const [label,helper] of [['main-0.3.5',previous],['0.3.6',current]]){
   if(!helper)continue;const start=performance.now();
   const result=spawnSync('/usr/bin/time',['-l',helper,file,'--private-copy'],{input:'\n4\nSELECT message_content FROM sample',maxBuffer:32*1024*1024});
   const stderr=String(result.stderr),rss=stderr.match(/(\d+)\s+maximum resident set size/);
   results.push({label,exit:result.status,elapsedMs:Math.round(performance.now()-start),serializedBytes:result.stdout.length,nativePeakRssBytes:rss?Number(rss[1]):null,error:stderr.includes('ROW_BYTES')?'ROW_BYTES':null});
  }
  const reader=openBatchReader(current,file,'','4'),start=performance.now(),chunks=[];let maxResponseBytes=0;
  try{
   const n=Buffer.byteLength(body);
   for(let offset=0;offset<n;offset+=262144){const [row]=await reader.query(`SELECT hex(substr(CAST(message_content AS BLOB),${offset+1},262144)) AS chunk FROM sample`);chunks.push(Buffer.from(row.chunk,'hex'));maxResponseBytes=Math.max(maxResponseBytes,reader.responseBytes);}
   const joined=Buffer.concat(chunks),digest=b=>crypto.createHash('sha256').update(b).digest('hex');
   results.push({label:'0.3.6-bounded-reassembly',elapsedMs:Math.round(performance.now()-start),requests:chunks.length,maxResponseBytes,bodyBytes:joined.length,complete:digest(joined)===digest(Buffer.from(body)),nodePeakRssKiB:process.resourceUsage().maxRSS});
  }finally{await reader.close()}
  console.log(JSON.stringify(results,null,2));
 }finally{fs.rmSync(root,{recursive:true,force:true})}
})().catch(()=>{console.error('Synthetic benchmark failed');process.exitCode=1});
