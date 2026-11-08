const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const identity=require('./app-identity.cjs');
const within=(file,root)=>file===root||file.startsWith(root+path.sep);
function canonical(file){file=path.resolve(file);if(fs.existsSync(file))return fs.realpathSync(file);const parent=path.dirname(file);if(parent===file)throw Error('无法规范化数据路径。');return path.join(canonical(parent),path.basename(file))}
function guardProfile(root,{legacyRoots=[],validation=false,tempRoots=[os.tmpdir(),'/private/tmp']}={}){
 if(!path.isAbsolute(root))throw Error('数据目录必须为绝对路径。');
 const target=canonical(root),legacy=legacyRoots.map(canonical);
 if(legacy.some(old=>within(target,old)||within(old,target)))throw Error('Next 数据目录不得与旧版目录重叠。');
 if(validation&&!tempRoots.map(canonical).some(base=>target!==base&&within(target,base)))throw Error('验证资料必须位于独立临时子目录。');
 if(!validation&&path.resolve(root)!==target)throw Error('Next 数据目录不得经符号链接重定向。');
 if(fs.existsSync(root)&&fs.lstatSync(root).isSymbolicLink())throw Error('数据目录不得为符号链接。');
 let remaining=100000;
 function inspect(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
  if(--remaining<0)throw Error('数据目录校验超过安全上限。');
  const file=path.join(dir,entry.name),stat=fs.lstatSync(file);
  // Chromium owns these runtime locks; never treat them as data/cache authority.
  if(dir===target&&['SingletonLock','SingletonCookie','SingletonSocket'].includes(entry.name))continue;
  if(stat.isSymbolicLink())throw Error('数据库、凭据或缓存不得含符号链接。');
  if(stat.isDirectory())inspect(file);else if(!stat.isFile()||stat.nlink!==1)throw Error('数据文件必须为独立普通文件。');
 }}
 if(fs.existsSync(target))inspect(target);
 return target;
}
function initializeProfile(app,{validationArg,argv=process.argv}={}){
 const appData=canonical(app.getPath('appData')),legacyRoots=[path.join(appData,'memory-weave'),path.join(appData,'Memory Weave')];
 const requested=validationArg?validationArg.slice('--validation-user-data='.length):path.join(appData,identity.name);
 const root=guardProfile(requested,{legacyRoots,validation:!!validationArg});
 const supplied=argv.find(arg=>arg.startsWith('--user-data-dir='));
 if(supplied&&canonical(supplied.slice('--user-data-dir='.length))!==root)throw Error('拒绝不匹配的 Chromium 数据目录。');
 fs.mkdirSync(root,{recursive:true,mode:0o700});
 const marker=path.join(root,'next-profile.json');
 if(fs.existsSync(marker)){
  const saved=JSON.parse(fs.readFileSync(marker,'utf8'));if(saved.appId!==identity.appId||saved.name!==identity.name)throw Error('数据目录身份不匹配。');
 }else{
  if(!validationArg&&fs.readdirSync(root).some(name=>!['SingletonLock','SingletonCookie','SingletonSocket'].includes(name)))throw Error('未标识的既有数据目录需要人工核对。');
  fs.writeFileSync(marker,JSON.stringify({format:1,appId:identity.appId,name:identity.name}),{mode:0o600,flag:'wx'});
 }
 app.setName(identity.name); // Set before safeStorage is imported or initialized.
 app.setPath('userData',root);
 const session=path.join(root,'chromium');fs.mkdirSync(session,{recursive:true,mode:0o700});app.setPath('sessionData',session);
 // Chromium might have inherited a CLI switch. Only this checked profile may be used.
 app.commandLine?.appendSwitch('user-data-dir',root);
 return Object.freeze({root,database:path.join(root,'workspace.sqlite'),session,appId:identity.appId});
}
module.exports={guardProfile,initializeProfile,canonical,within};
