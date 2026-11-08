const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');

function defaultLocations(home=os.homedir()){
  return [
    path.join(home,'Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files'),
    path.join(home,'Library/Containers/com.tencent.xinWeChat/Data/Documents/app_data'),
    path.join(home,'Library/Application Support/WeChat/xwechat_files'),
    path.join(home,'Documents/xwechat_files')
  ];
}
async function accountInfo(root){
  const canonical=await fs.realpath(root);
  const db=await fs.stat(path.join(canonical,'db_storage'));
  const contact=await fs.stat(path.join(canonical,'db_storage/contact/contact.db'));
  const message=await fs.stat(path.join(canonical,'db_storage/message'));
  if(!db.isDirectory()||!contact.isFile()||!message.isDirectory())return null;
  return {root:canonical,label:path.basename(canonical),modifiedAt:Math.max(contact.mtimeMs,message.mtimeMs)};
}
// Metadata only: fixed macOS locations and their immediate children. No key or DB contents.
async function discoverWeChat(home=os.homedir()){
  const accounts=new Map(),warnings=[],locations=[];
  for(const base of defaultLocations(home)){
    try{
      const canonical=await fs.realpath(base);
      const entries=await fs.readdir(canonical,{withFileTypes:true});locations.push(base);
      for(const entry of entries){
        if(!entry.isDirectory()||entry.name.startsWith('.'))continue;
        const root=path.join(canonical,entry.name);
        try{const info=await accountInfo(root);if(info&&info.root.startsWith(canonical+path.sep))accounts.set(info.root,info);}
        catch(e){if(['EACCES','EPERM'].includes(e.code))warnings.push('部分微信账号目录无读取权限，可使用“手动选择”授予访问。');else if(!['ENOENT','ENOTDIR'].includes(e.code))warnings.push('部分账号目录暂时不可访问，请重试或手动选择。');}
      }
    }catch(e){if(['EACCES','EPERM'].includes(e.code))warnings.push('微信常见数据目录访问被系统拒绝，请使用“手动选择”。');else if(!['ENOENT','ENOTDIR'].includes(e.code))warnings.push('微信数据目录暂时不可访问。');}
  }
  return {accounts:[...accounts.values()].sort((a,b)=>b.modifiedAt-a.modifiedAt||a.root.localeCompare(b.root)),warnings:[...new Set(warnings)],defaultPath:locations[0]||path.join(home,'Library/Containers/com.tencent.xinWeChat/Data/Documents')};
}
async function normalizeSelection(selected){
  const canonical=await fs.realpath(selected);
  const root=path.basename(canonical)==='db_storage'?path.dirname(canonical):canonical;
  try{const info=await accountInfo(root);if(info)return info;}catch{}
  throw Error('这里不是受支持的微信账号目录。请自动检测，或选择包含 db_storage/contact/contact.db 的账号文件夹（也可选择 db_storage）。');
}
module.exports={defaultLocations,accountInfo,discoverWeChat,normalizeSelection};
