const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync,execFileSync}=require('node:child_process');
const {validate,slug,branchGate,sections}=require('../../scripts/stage-review.cjs');
function report(overrides={}){const meta={version:'0.3.6',task:'history-sync',baseCommit:'a'.repeat(40),codeCommit:'__CODE_COMMIT__',status:'PARTIAL',checks:{source:'PASS',automated:'PASS',machine:'PARTIAL',integrity:'PARTIAL',privacy:'PASS'},openP0:[],openP1:[],unverified:['real large archive'],independentReview:'PENDING',...overrides};return `<!-- review-gate\n${JSON.stringify(meta)}\n-->\n`+sections.map(x=>'## '+x+'\n实际证据；未验证事项保留。').join('\n')}
test('review publication accepts honest partial evidence but rejects failed or contradictory acceptance',()=>{
 assert.equal(validate(report(),'0.3.6','history-sync').status,'PARTIAL');
 for(const patch of [{status:'FAIL'},{status:'PASS'},{openP0:['privacy']},{checks:{source:'PASS',automated:'FAIL',privacy:'PASS'}}])assert.throws(()=>validate(report(patch),'0.3.6','history-sync'));
 assert.throws(()=>validate(report().replace('## 性能测试','## other'),'0.3.6','history-sync'));
 assert.throws(()=>validate(report()+'\n待填写','0.3.6','history-sync'));
});
test('review path and publication branch reject traversal and direct main publication',()=>{
 for(const x of ['../private','history/sync','','x;echo'])assert.throws(()=>slug(x));
 for(const b of ['main','master','HEAD',''])assert.throws(()=>branchGate(b));branchGate('codex/repair');
});
test('prepare generates required report once without overwriting existing work',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mw-review-workflow-'));const script=path.resolve(__dirname,'../../scripts/stage-review.cjs');
 const git=args=>execFileSync('git',args,{cwd:dir,stdio:'pipe'}).toString().trim();
 try{
  fs.mkdirSync(path.join(dir,'app'));fs.writeFileSync(path.join(dir,'app/package.json'),'{"version":"0.3.6"}');
  git(['init','-b','codex/test']);git(['config','user.name','Synthetic']);git(['config','user.email','synthetic@example.invalid']);git(['add','.']);git(['commit','-m','synthetic']);
  const base=git(['rev-parse','HEAD']);const args=[script,'prepare','history-sync',base];
  assert.equal(spawnSync(process.execPath,args,{cwd:dir}).status,0);
  const file=path.join(dir,'docs/reviews/v0.3.6-history-sync-review.md'),body=fs.readFileSync(file,'utf8');
  for(const s of sections)assert.ok(body.includes('## '+s));
  assert.equal(spawnSync(process.execPath,args,{cwd:dir}).status,1);assert.equal(fs.readFileSync(file,'utf8'),body);
  git(['checkout','-b','main']);const before=git(['rev-parse','HEAD']);
  assert.equal(spawnSync(process.execPath,[script,'publish','test','history-sync'],{cwd:dir}).status,1);assert.equal(git(['rev-parse','HEAD']),before);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

const {taskFiles,commitTask,githubApproval}=require('../../scripts/stage-review.cjs');
function dirtyRepository(){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'mw-scope-')));
 const git=args=>execFileSync('git',args,{cwd:root,stdio:'pipe'}).toString().trim();
 git(['init','-b','codex/scope']);git(['config','user.name','Synthetic']);git(['config','user.email','synthetic@example.invalid']);git(['config','core.hooksPath',path.join(root,'.git/hooks')]);
 for(let i=0;i<41;i++)fs.writeFileSync(path.join(root,`unrelated-${i}.txt`),'preserve baseline');
 for(const f of ['other.txt','task.cjs','report.md','task-delete.txt'])fs.writeFileSync(path.join(root,f),'baseline');
 git(['add','.']);git(['commit','-m','baseline']);
 for(let i=0;i<41;i++)fs.unlinkSync(path.join(root,`unrelated-${i}.txt`));
 fs.writeFileSync(path.join(root,'other.txt'),'user unsaved work');fs.writeFileSync(path.join(root,'private-untracked.txt'),'synthetic user data');fs.writeFileSync(path.join(root,'task.cjs'),'task change');
 const index=path.join(root,'.git/index'),before=()=>({head:git(['rev-parse','HEAD']),index:fs.readFileSync(index),unrelated:git(['diff','--','other.txt',...Array.from({length:41},(_,i)=>`unrelated-${i}.txt`)]),other:fs.readFileSync(path.join(root,'other.txt'),'utf8'),untracked:fs.readFileSync(path.join(root,'private-untracked.txt'),'utf8')});
 return {root,git,index,before,clean:()=>fs.rmSync(root,{recursive:true,force:true})};
}
function assertUserWork(f,before){
 assert.equal(f.git(['diff','--cached','--name-only']),'');
 assert.equal(f.before().unrelated,before.unrelated);assert.equal(f.before().other,before.other);assert.equal(f.before().untracked,before.untracked);
 assert.equal(f.git(['ls-files','--deleted','-z']).split('\0').filter(Boolean).length,41);
 for(let i=0;i<41;i++)assert.equal(fs.existsSync(path.join(f.root,`unrelated-${i}.txt`)),false);
}
test('task publication commits only its explicit files, preserving 41 unrelated deletions and all other user work',()=>{
 const f=dirtyRepository(),before=f.before();try{
  fs.writeFileSync(path.join(f.root,'task-new.cjs'),'explicit new task file');
  const entries=taskFiles(f.root,[{path:'task.cjs',action:'modify'},{path:'task-new.cjs',action:'add'}]);
  const sha=commitTask(f.root,entries,'task source',({git,staged})=>{
   assert.deepEqual(staged,['task-new.cjs','task.cjs']);assert.equal(git(['diff','--cached','--name-only']),'task-new.cjs\ntask.cjs');assert.deepEqual(fs.readFileSync(f.index),before.index);
  });
  assert.notEqual(sha,before.head);assert.equal(f.git(['diff-tree','--no-commit-id','--name-only','-r','HEAD']),'task-new.cjs\ntask.cjs');
  fs.writeFileSync(path.join(f.root,'report.md'),'review evidence');
  commitTask(f.root,taskFiles(f.root,[{path:'report.md',action:'modify'}]),'task report');
  assert.equal(f.git(['diff-tree','--no-commit-id','--name-only','-r','HEAD']),'report.md');assertUserWork(f,before);
  assert.equal(f.git(['show','HEAD:other.txt']),'baseline');assert.equal(f.git(['show','HEAD:unrelated-0.txt']),'preserve baseline');
 }finally{f.clean()}
});
test('failed staged verification leaves HEAD, real index bytes, deletions and working contents untouched',()=>{
 const f=dirtyRepository(),before=f.before();try{
  assert.throws(()=>commitTask(f.root,taskFiles(f.root,[{path:'task.cjs',action:'modify'}]),'must not commit',()=>{throw Error('synthetic privacy gate failure')}),/privacy gate/);
  assert.equal(f.git(['rev-parse','HEAD']),before.head);assert.deepEqual(fs.readFileSync(f.index),before.index);assertUserWork(f,before);
 }finally{f.clean()}
});
test('a failing real commit hook never stages or restores unrelated work',()=>{
 const f=dirtyRepository(),before=f.before();try{
  const hook=path.join(f.root,'.git/hooks/pre-commit');fs.writeFileSync(hook,'#!/bin/sh\nexit 9\n',{mode:0o755});
  assert.throws(()=>commitTask(f.root,taskFiles(f.root,[{path:'task.cjs',action:'modify'}]),'must fail'),/commit/);
  assert.equal(f.git(['rev-parse','HEAD']),before.head);assert.deepEqual(fs.readFileSync(f.index),before.index);assertUserWork(f,before);
 }finally{f.clean()}
});
test('existing user staging is rejected without changing staged bytes or working files',()=>{
 const f=dirtyRepository();try{
  f.git(['add','other.txt']);const before=f.before();
  assert.throws(()=>commitTask(f.root,taskFiles(f.root,[{path:'task.cjs',action:'modify'}]),'must not commit'),/初始暂存区/);
  assert.deepEqual(fs.readFileSync(f.index),before.index);assert.equal(f.git(['rev-parse','HEAD']),before.head);assert.equal(f.before().unrelated,before.unrelated);
 }finally{f.clean()}
});
test('manifest denies broad paths and implicit deletion, permits only specifically authorized delete, detects concurrent edits',()=>{
 const f=dirtyRepository(),before=f.before();try{
  for(const entry of [{path:'.',action:'modify'},{path:'*.txt',action:'delete'},{path:'../escape',action:'add'},{path:'unrelated-0.txt',action:'modify'}])assert.throws(()=>taskFiles(f.root,[entry]));
  assert.throws(()=>commitTask(f.root,taskFiles(f.root,[{path:'task.cjs',action:'modify'}]),'changed',()=>fs.writeFileSync(path.join(f.root,'task.cjs'),'new user edit')),/审查后变化/);
  assert.equal(fs.readFileSync(path.join(f.root,'task.cjs'),'utf8'),'new user edit');assert.deepEqual(fs.readFileSync(f.index),before.index);
  fs.unlinkSync(path.join(f.root,'task-delete.txt'));
  commitTask(f.root,taskFiles(f.root,[{path:'task-delete.txt',action:'delete'}]),'explicit task deletion');
  assert.equal(f.git(['diff-tree','--no-commit-id','--name-status','-r','HEAD']),'D\ttask-delete.txt');assertUserWork(f,before);
 }finally{f.clean()}
});
test('report APPROVED alone, self approval, stale approval and later change request are not independent GitHub approval',()=>{
 const head='a'.repeat(40),passing={status:'PASS',codeCommit:head,checks:{source:'PASS',automated:'PASS',machine:'PASS',integrity:'PASS',privacy:'PASS'},unverified:[],independentReview:'APPROVED'};
 assert.throws(()=>validate(report(passing),'0.3.6','history-sync'),/GitHub 独立批准/);
 const evidence={headRefOid:head,reviewDecision:'APPROVED',author:{login:'author'},reviews:[{author:{login:'reviewer'},state:'APPROVED',commit:{oid:head}}]};
 assert.equal(githubApproval(evidence,head),true);assert.equal(validate(report(passing),'0.3.6','history-sync',evidence).status,'PASS');
 assert.equal(githubApproval({...evidence,headRefOid:'b'.repeat(40)},head),false);
 assert.equal(githubApproval({...evidence,reviews:[{...evidence.reviews[0],author:{login:'author'}}]},head),false);
 assert.equal(githubApproval({...evidence,reviews:[...evidence.reviews,{author:{login:'reviewer'},state:'CHANGES_REQUESTED',commit:{oid:head}}]},head),false);
 assert.equal(githubApproval({...evidence,reviews:[{...evidence.reviews[0],commit:{oid:'b'.repeat(40)}}]},head),false);
});
test('report failure after the source commit preserves unrelated work and leaves no real staged changes',()=>{
 const f=dirtyRepository(),before=f.before();try{
  const code=commitTask(f.root,taskFiles(f.root,[{path:'task.cjs',action:'modify'}]),'source passed');
  fs.writeFileSync(path.join(f.root,'report.md'),'report retained after failure');
  const index=fs.readFileSync(f.index);
  assert.throws(()=>commitTask(f.root,taskFiles(f.root,[{path:'report.md',action:'modify'}]),'report rejected',()=>{throw Error('synthetic report scan failure')}),/report scan/);
  assert.equal(f.git(['rev-parse','HEAD']),code);assert.deepEqual(fs.readFileSync(f.index),index);assertUserWork(f,before);
  assert.equal(fs.readFileSync(path.join(f.root,'report.md'),'utf8'),'report retained after failure');
 }finally{f.clean()}
});
test('explicit selection excludes the 41 deletions a broad Git add would stage',()=>{
 const f=dirtyRepository();try{
  fs.writeFileSync(path.join(f.root,'task-new.cjs'),'scoped synthetic change');
  f.git(['add','--all']);
  assert.equal(f.git(['diff','--cached','--diff-filter=D','--name-only']).split('\n').length,41);
  assert.ok(f.git(['diff','--cached','--name-only']).includes('other.txt'));
  assert.ok(f.git(['diff','--cached','--name-only']).includes('private-untracked.txt'));
  f.git(['reset','-q','HEAD']);
  const before=f.before();
  commitTask(f.root,taskFiles(f.root,[{path:'task-new.cjs',action:'add'}]),'paired fixed scope');
  assertUserWork(f,before);
  assert.equal(f.git(['diff-tree','--no-commit-id','--name-only','-r','HEAD']),'task-new.cjs');
 }finally{f.clean()}
});
