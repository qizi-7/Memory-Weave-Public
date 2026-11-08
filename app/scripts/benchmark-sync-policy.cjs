// Execute baseline/current implementation fragments against identical synthetic inputs.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{execFileSync}=require('node:child_process'),{DatabaseSync}=require('node:sqlite'),{performance}=require('node:perf_hooks');
const base=process.argv[2]||'origin/main';const source=(f,old)=>old?execFileSync('git',['show',`${base}:app/electron/${f}`],{encoding:'utf8'}):fs.readFileSync('electron/'+f,'utf8');
(async()=>{
 const results=[];
 for(const old of [true,false]){
  const label=old?'main-0.3.5':'0.3.6',main=source('main.cjs',old),adapter=source('wechat-adapter.cjs',old);
  const retry=main.slice(main.indexOf("if(method==='syncRetry')"),main.indexOf("if(method==='syncStatus')"));
  let target;const options={profile:'3',selfId:'synthetic-self',displayName:'Synthetic',allowDecrypted:false};
  const context={syncTask:{state:'error',account:'synthetic'},call:async()=>{},rootFor:async()=>'/synthetic',sourceKeys:new Map(),mediaKey:()=> 'synthetic-media-only',authorizedRoots:new Set(),retryOptions:{target:(root,id)=>{target=id},get:()=>options},sourceCredential:require('../electron/wechat-retry-context.cjs').sourceCredential,vault:{hasKey:()=>false}};
  const execute=()=>vm.runInNewContext(`(async()=>{let method='syncRetry',args={sourceId:'123456789abc'};${retry};return args})()`,context);
  let denied=false,mediaUsed=false;try{mediaUsed=(await execute())?.key==='synthetic-media-only'}catch{denied=true}
  context.sourceKeys.set('/synthetic','synthetic-database-only');const args=await execute();
  const kept=['profile','selfId','displayName','allowDecrypted'].filter(k=>args[k]===options[k]);
  const start=adapter.indexOf('const adaptivePage=async'),end=adapter.indexOf('const queryPage=',start),calls=[];
  const retryPolicy=require('../electron/wechat-sync-retry.cjs');
  // Baseline retry set extracted from its real module, without importing Electron.
  const oldRetry=source('wechat-sync-retry.cjs',true),oldSet=oldRetry.match(/const retryableRead=new Set\((\[[^;]+\])\)/)?.[1];
  const policy={pageLimits:retryPolicy.pageLimits,retryableRead:old&&oldSet?vm.runInNewContext('new Set('+oldSet+')'):retryPolicy.retryableRead,recordError:()=>{},circuitOpen:()=>false,onProgress:()=>{},account:{id:'synthetic'},scanned:0,added:0,errors:0};
  const adaptive=vm.runInNewContext(`(()=>{${adapter.slice(start,end)};return adaptivePage})()`,policy);
  let timeoutRecovered=false;try{const r=await adaptive(async n=>{calls.push(n);if(n>100)throw Object.assign(Error('synthetic timeout'),{code:'NATIVE_TIMEOUT',queryFailure:true});return {rows:[1]}},500,{source:'synthetic',phase:'history'});timeoutRecovered=r.limit===100}catch{}
  results.push({label,retry:{mediaUsed,deniedWithoutDatabaseCredential:denied,targetRetained:target==='123456789abc',retainedOptions:kept},timeout:{calls,recovered:timeoutRecovered}});
 }
 const db=new DatabaseSync(':memory:');db.exec(`CREATE TABLE messages(id INTEGER PRIMARY KEY,create_time INTEGER NOT NULL);CREATE INDEX timeline ON messages(create_time);WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<100000) INSERT INTO messages SELECT i,1700000000+(i/10) FROM n`);
 const pagination=[],pages=[];
 for(const [label,time] of [['main-0.3.5','coalesce(CAST("create_time" AS INTEGER),-1)'],['0.3.6','"create_time"']]){
  const sql=`SELECT rowid,create_time FROM messages WHERE (${time}<1700009000 OR (${time}=1700009000 AND rowid<90000)) ORDER BY ${time} DESC,rowid DESC LIMIT 500`;
  const plan=db.prepare('EXPLAIN QUERY PLAN '+sql).all().map(x=>x.detail),start=performance.now();let rows;for(let i=0;i<5;i++)rows=db.prepare(sql).all();pages.push(rows);pagination.push({label,rows:rows.length,first:rows[0].id,last:rows.at(-1).id,averageMs:Number(((performance.now()-start)/5).toFixed(3)),plan});
 }
 assert.deepEqual(pages[0],pages[1]);assert.equal(results[0].retry.mediaUsed,true);assert.equal(results[1].retry.mediaUsed,false);assert.equal(results[1].retry.deniedWithoutDatabaseCredential,true);assert.equal(results[1].retry.retainedOptions.length,4);assert.equal(results[0].timeout.recovered,false);assert.equal(results[1].timeout.recovered,true);
 db.close();console.log(JSON.stringify({policies:results,pagination},null,2));
})().catch(e=>{console.error(e.message);process.exitCode=1});
