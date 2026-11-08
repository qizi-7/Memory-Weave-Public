const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const sections=['任务概况','Bug 根因分析','代码修改清单','测试与验证','数据完整性检查','性能测试','未解决问题与风险','最终验收结论'];
function slug(value){if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value||''))throw Error('任务名称必须为小写英文短横线标识');return value}
function reviewBase(meta){const branch=meta.baseBranch||'main';if(!/^(?:main|codex\/[A-Za-z0-9][A-Za-z0-9._/-]*)$/.test(branch)||branch.includes('..')||branch.endsWith('/')||branch.includes('//'))throw Error('审查基线分支无效');return branch}
function branchGate(branch){if(!branch||['main','master','HEAD'].includes(branch))throw Error('必须在独立开发分支发布审查');}
function validate(body,version,task,reviewEvidence){
 const match=body.match(/<!-- review-gate\s*([\s\S]*?)\s*-->/);if(!match)throw Error('缺少 review-gate');
 const m=JSON.parse(match[1]);
 if(m.version!==version||m.task!==slug(task)||!/^[a-f0-9]{40}$/.test(m.baseCommit)||!(/^[a-f0-9]{40}$/.test(m.codeCommit)||m.codeCommit==='__CODE_COMMIT__'))throw Error('版本或 SHA 元数据无效');
 if(!['PASS','PARTIAL'].includes(m.status))throw Error('FAIL 或未完成报告不得发布');
 for(const section of sections)if(!body.includes('## '+section))throw Error('缺少报告部分 '+section);
 if(/待填写|TODO|TBD/.test(body))throw Error('报告存在未填模板');
 for(const key of ['source','automated','machine','integrity','privacy'])if(!['PASS','PARTIAL','FAIL'].includes(m.checks?.[key]))throw Error('缺少验收项 '+key);
 if(m.checks.automated!=='PASS'||m.checks.privacy!=='PASS')throw Error('自动测试或隐私检查未通过');
 for(const key of ['openP0','openP1','unverified'])if(!Array.isArray(m[key]))throw Error('缺少风险数组');
 if(m.openP0.length)throw Error('存在 P0，停止发布');
 if(m.status==='PASS'&&(Object.values(m.checks).some(x=>x!=='PASS')||m.openP1.length||m.unverified.length||m.independentReview!=='APPROVED'))throw Error('PASS 与未完成验收矛盾');
 if(m.status==='PASS'&&!githubApproval(reviewEvidence,m.codeCommit))throw Error('报告 APPROVED 不能替代当前提交的 GitHub 独立批准');
 if(!['PENDING','APPROVED','CHANGES_REQUESTED'].includes(m.independentReview))throw Error('独立审查状态无效');
 reviewBase(m);return m;
}
// Every path is explicit and literal. A delete requires its own action; directory/pathspec expansion is denied.
function gitAt(root,args,env={}){
 const r=spawnSync('git',args,{cwd:root,env:{...process.env,...env,GIT_LITERAL_PATHSPECS:'1'},encoding:'utf8',maxBuffer:32*1024*1024});
 if(r.status!==0)throw Error(`git ${args[0]} 失败，退出码 ${r.status}`);return r.stdout.trim();
}
function taskFiles(root,list){
 root=fs.realpathSync(root);
 if(!Array.isArray(list)||!list.length)throw Error('必须提供明确的任务文件清单');
 const seen=new Set();
 return list.map(entry=>{
  const f=entry?.path,action=entry?.action;
  if(typeof f!=='string'||!f||path.isAbsolute(f)||f.includes(String.fromCharCode(92))||f.split('/').some(p=>!p||p==='.'||p==='..'||p==='.git')||/[\x00-\x1f*?\[\]:]/.test(f)||seen.has(f))throw Error('任务路径无效或重复');
  if(!['add','modify','delete'].includes(action))throw Error('任务文件必须明确 add/modify/delete');seen.add(f);
  const tracked=!!gitAt(root,['ls-files','--',f]);
  const full=path.join(root,f),stat=fs.lstatSync(full,{throwIfNoEntry:false});
  if(action==='delete'){if(!tracked||stat)throw Error('删除清单与实际文件状态不符');}
  else{
   if(!stat?.isFile()||stat.isSymbolicLink()||fs.realpathSync(full)!==full)throw Error('任务必须为仓库内普通文件');
   if((action==='add')===tracked)throw Error('任务动作与 Git 跟踪状态不符');
  }
  return {path:f,action,hash:stat?crypto.createHash('sha256').update(fs.readFileSync(full)).update(String(stat.mode)).digest('hex'):null};
 });
}
function assertTaskUnchanged(root,entries){
 const current=taskFiles(root,entries);
 if(current.some((e,i)=>e.hash!==entries[i].hash))throw Error('任务文件在审查后变化，停止提交');
}
// A separate index is built from HEAD. Never stage/reset/restore an unrelated working file.
function commitTask(root,entries,message,verify=()=>{}){
 root=fs.realpathSync(root);
 if(gitAt(root,['diff','--cached','--name-only']))throw Error('初始暂存区必须为空；不改写既有暂存状态');
 assertTaskUnchanged(root,entries);
 const oldHead=gitAt(root,['rev-parse','HEAD']);
 const index=gitAt(root,['rev-parse','--path-format=absolute','--git-path','index']);
 const original=fs.existsSync(index)?fs.readFileSync(index):null;
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'mw-task-index-')),env={GIT_INDEX_FILE:path.join(temp,'index')};
 const git=args=>gitAt(root,args,env);
 const unchangedIndex=()=>{const now=fs.existsSync(index)?fs.readFileSync(index):null;if(original===null?now!==null:!now||!original.equals(now))throw Error('用户暂存区已变化，停止提交');};
 let committed=false;
 try{
  git(['read-tree','HEAD']);git(['add','--',...entries.map(e=>e.path)]);
  const staged=git(['diff','--cached','--name-only','-z']).split('\0').filter(Boolean);
  if(staged.some(f=>!entries.some(e=>e.path===f)))throw Error('暂存范围超出任务清单');
  verify({env,git,staged,temp});assertTaskUnchanged(root,entries);unchangedIndex();
  if(gitAt(root,['rev-parse','HEAD'])!==oldHead)throw Error('HEAD 已变化，停止提交');
  if(!staged.length)return oldHead;
  git(['commit','-m',message]);committed=true;
  return gitAt(root,['rev-parse','HEAD']);
 }finally{
  // Only after a successful commit, move these index entries to the new HEAD.
  // Failure before commit leaves the real index byte-for-byte unchanged.
  try{if(committed){unchangedIndex();gitAt(root,['reset','-q','HEAD','--',...entries.map(e=>e.path)]);}}
  finally{fs.rmSync(temp,{recursive:true,force:true});}
 }
}
function githubApproval(pr,head){
 if(!pr||pr.headRefOid!==head||pr.reviewDecision!=='APPROVED'||!pr.author?.login)return false;
 const latest=new Map();for(const review of pr.reviews||[]){if(review.author?.login&&review.state!=='COMMENTED')latest.set(review.author.login,review);}
 if([...latest.values()].some(r=>r.state==='CHANGES_REQUESTED'))return false;
 return [...latest.values()].some(r=>r.author.login!==pr.author.login&&r.state==='APPROVED'&&r.commit?.oid===head);
}
function main(){
 const run=(cmd,args,options={})=>{const r=spawnSync(cmd,args,{encoding:'utf8',maxBuffer:32*1024*1024,...options});if(r.status!==0)throw Error(`${cmd} 失败，退出码 ${r.status}: ${(r.stderr||'').slice(-1200)}`);return r.stdout.trim()};
 process.chdir(run('git',['rev-parse','--show-toplevel']));
 const version=JSON.parse(fs.readFileSync('app/package.json')).version,mode=process.argv[2];
 if(mode!=='prepare'||process.argv.length!==5)throw Error('用法 prepare task base');
 const task=slug(process.argv[3]),file=`docs/reviews/v${version}-${task}-review.md`;
 const branch=run('git',['branch','--show-current']);branchGate(branch);
 if(mode==='prepare'){
  if(fs.existsSync(file))throw Error('报告已存在，拒绝覆盖');
  const base=run('git',['rev-parse','--verify',process.argv[4]+'^{commit}']);
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,`# Memory Weave ${version} ${task}\n\n<!-- review-gate\n${JSON.stringify({version,task,baseCommit:base,codeCommit:'__CODE_COMMIT__',status:'PARTIAL',checks:{source:'PARTIAL',automated:'PARTIAL',machine:'PARTIAL',integrity:'PARTIAL',privacy:'PARTIAL'},openP0:[],openP1:[],unverified:['待填写'],independentReview:'PENDING'},null,2)}\n-->\n\n`+sections.map(s=>`## ${s}\n\n待填写；未执行验证明确写未验证。\n`).join('\n'));console.log(file);return;
 }

}
module.exports={reviewBase,validate,slug,branchGate,sections,taskFiles,commitTask,githubApproval};
if(require.main===module){try{main()}catch(e){console.error(e.message);process.exitCode=1}}
