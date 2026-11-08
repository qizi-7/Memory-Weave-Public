const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..');
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
const gitCommit=git('rev-parse','HEAD'),dirty=!!git('status','--porcelain','--untracked-files=no');
const hash=crypto.createHash('sha256');
for(const file of git('ls-files','app').split('\n').sort()){if(fs.existsSync(path.join(root,file)))hash.update(file).update(fs.readFileSync(path.join(root,file)));}
const sourceHash=hash.digest('hex');
const info={gitCommit,dirty,sourceHash,buildId:`${gitCommit.slice(0,12)}-${sourceHash.slice(0,12)}${dirty?'-dirty':''}`,builtAt:new Date().toISOString(),framing:'LF-bytes-v1'};
fs.writeFileSync(path.join(root,'app/electron/build-info.json'),JSON.stringify(info,null,2)+'\n');
console.log(JSON.stringify(info));
