const fs=require('node:fs');
const {execFileSync}=require('node:child_process');

const git=(args,options={})=>execFileSync('git',args,{encoding:'utf8',...options});
const exact=new Set([
 '.gitignore','README.md','AGENTS.md','LICENSE','THIRD_PARTY_NOTICES.md',
 'ARCHITECTURE.md','CODE_MAP.md','TESTING.md','AI_ANALYSIS_GUIDE.md',
 'scripts/repository-check.cjs','scripts/stage-review.cjs',
 'app/index.html','app/package.json','app/package-lock.json','app/tsconfig.json','app/vite.config.ts',
 'app/native/reader.c','app/tests/fixtures/message-display.json',
 // Public versioned shortcode vocabulary only; other Electron JSON remains denied.
 'app/electron/text-emoji-names.json'
]);
const sourcePaths=[
 /^docs\/[0-9]{2}-[a-zA-Z0-9.-]+\.md$/,
 /^app\/src\/[\w/-]+\.(?:ts|tsx|css)$/,
 /^app\/electron\/[\w/-]+\.cjs$/,
 /^app\/scripts\/[\w-]+\.cjs$/,
 /^app\/tests\/[\w.-]+\.(?:cjs|c)$/,
 /^app\/resources\/licenses\/[\w.-]+\.txt$/
];
const pathAllowed=file=>!file.startsWith('app/electron/vendor/') && (exact.has(file)||sourcePaths.some(rule=>rule.test(file))) &&
 !file.split('/').some(part=>/^(?:private|secrets?|credentials?|cache|exports?|logs?)$/i.test(part));
const maxFile=2*1024*1024;
const decoder=new TextDecoder('utf-8',{fatal:true});
function verify(file,buffer){
 if(!pathAllowed(file))throw Error('拒绝未经审查的路径 '+file);
 if(buffer.length>maxFile)throw Error('文件超过源码大小上限 '+file);
 if(buffer.includes(0))throw Error('拒绝二进制文件 '+file);
 try{decoder.decode(buffer)}catch{throw Error('文件不是 UTF-8 源码或文档 '+file)}
}
const mode=process.argv[2]||'index';
if(mode==='working'){
 const files=new Set(git(['ls-files','--cached','--others','--exclude-standard','-z']).split('\0').filter(Boolean));
 for(const file of files){
  if(!pathAllowed(file))throw Error('拒绝未经审查的路径 '+file);
  if(!fs.existsSync(file)&&!fs.lstatSync(file,{throwIfNoEntry:false}))continue;
  if(!fs.lstatSync(file).isFile())throw Error('拒绝链接或非普通文件 '+file);
  const size=fs.statSync(file).size;
  if(size>maxFile)throw Error('文件超过源码大小上限 '+file);
  verify(file,fs.readFileSync(file));
 }
 console.log('工作区源码候选路径通过检查');
}else{
 const ref=mode==='index'?git(['write-tree']).trim():process.argv[3];
 if(mode!=='history'&&((mode!=='index'&&mode!=='tree')||!ref))throw Error('用法 repository-check.cjs working|index|tree REF|history');
 const refs=mode==='history'?git(['rev-list','--all',...process.argv.slice(3)]).trim().split('\n').filter(Boolean):[ref];
 const checked=new Set();
 let bytes=0,files=0;
 for(const revision of refs){
  const entries=git(['ls-tree','-rlz',revision]).split('\0').filter(Boolean);
  files+=entries.length;
  for(const entry of entries){
   const tab=entry.indexOf('\t');
   const file=entry.slice(tab+1);
   const [perm,type,sha,size]=entry.slice(0,tab).trim().split(/\s+/);
   if(!['100644','100755'].includes(perm)||type!=='blob')throw Error('拒绝子模块、链接或非普通文件 '+file);
   if(!pathAllowed(file))throw Error('拒绝未经审查的路径 '+file);
   if(Number(size)>maxFile)throw Error('文件超过源码大小上限 '+file);
   if(checked.has(sha))continue;
   const blob=execFileSync('git',['cat-file','blob',sha],{maxBuffer:maxFile+1024});
   verify(file,blob);
   checked.add(sha);
   bytes+=blob.length;
  }
 }
 console.log(JSON.stringify({trees:refs.length,files,bytes,onlyAllowedTextFiles:true}));
}
