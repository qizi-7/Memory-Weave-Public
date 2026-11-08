// Explicit workspace COPY only. Reports plans, timings and aggregate counts; never names/bodies/paths.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{performance}=require('node:perf_hooks');
const os=require('node:os');
const {DatabaseSync}=require('node:sqlite'),{execFileSync}=require('node:child_process'),Module=require('node:module');
const {Store}=require('../electron/store.cjs'),{prepareProjection}=require('../electron/archive-projection.cjs');
(async()=>{
 const [file,mode,out]=process.argv.slice(2);if(!file||!['before','after'].includes(mode)||!out)throw Error('explicit isolated copy, before|after and private output prefix required');
 const resolved=fs.realpathSync(file),roots=[fs.realpathSync(os.tmpdir()),fs.realpathSync('/private/tmp')];
 if(!roots.some(root=>resolved.startsWith(root+path.sep))||fs.lstatSync(file).isSymbolicLink()||fs.statSync(file).nlink!==1)throw Error('profiling requires an independent temporary copy');
 for(const suffix of ['-wal','-shm']){const st=fs.lstatSync(file+suffix,{throwIfNoEntry:false});if(st&&(!st.isFile()||st.nlink!==1))throw Error('profile sidecars must be independent regular files')}
 let ArchiveViews;
 if(mode==='before'){
  const filename=path.resolve(__dirname,'../electron/archive-views.cjs'),m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
  m._compile(execFileSync('git',['show','c56270b:app/electron/archive-views.cjs'],{encoding:'utf8'}),filename);ArchiveViews=m.exports.ArchiveViews;
 }else ArchiveViews=require('../electron/archive-views.cjs').ArchiveViews;
 let buildMs=null;if(mode==='after'){const store=new Store(file);store.close();const writable=new DatabaseSync(file,{timeout:3000});const start=performance.now();await prepareProjection(writable);buildMs=performance.now()-start;writable.close();}
 const db=new DatabaseSync(file,{readOnly:mode==='before'}),account=db.prepare('SELECT id FROM accounts ORDER BY id LIMIT 1').get().id;
 if(mode==='after')await prepareProjection(db); // same per-connection settings as the production statistics worker
 const samples=[];
 const instrument=new Proxy(db,{get(target,key){if(key==='prepare')return sql=>{const statement=target.prepare(sql);return new Proxy(statement,{get(st,k){if(!['get','all'].includes(k)){const v=st[k];return typeof v==='function'?v.bind(st):v}return(...args)=>{const plan=/^SELECT/i.test(sql)?target.prepare('EXPLAIN QUERY PLAN '+sql).all(...args).map(x=>x.detail):[];const start=performance.now();const value=st[k](...args);if(plan.length){const item={query:samples.length+1,ms:Math.round(performance.now()-start),plan,rows:Array.isArray(value)?value.length:1};samples.push(item);console.log(JSON.stringify(item));}return value}}})};const value=target[key];return typeof value==='function'?value.bind(target):value}});
 const args=process.argv[5]==='all'?{}:{account};
 const views=new ArchiveViews(instrument),start=performance.now(),result=views.stats(args),coldMs=performance.now()-start,warmStart=performance.now();views.stats(args);const warmMs=performance.now()-warmStart;
 const serialized=JSON.stringify(result),cpu=process.resourceUsage();
 fs.writeFileSync(out+'.payload.json',serialized,{mode:0o600});
 const metrics={mode,scope:process.argv[5]==='all'?'all-accounts':'single-account-all-messages',buildMs,coldMs,warmMs,total:result.summary.total,bytes:Buffer.byteLength(serialized),sha256:crypto.createHash('sha256').update(serialized).digest('hex'),peakRssKiB:cpu.maxRSS,cpuMs:(cpu.userCPUTime+cpu.systemCPUTime)/1000,samples};
 fs.writeFileSync(out+'.metrics.json',JSON.stringify(metrics,null,2),{mode:0o600});console.log(JSON.stringify({...metrics,samples:undefined}));db.close();
})().catch(e=>{console.error(e.code||e.message);process.exitCode=1});
