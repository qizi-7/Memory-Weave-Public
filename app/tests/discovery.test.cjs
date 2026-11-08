const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');
const {defaultLocations,discoverWeChat,normalizeSelection}=require('../electron/wechat-discovery.cjs');
async function account(root){await fs.mkdir(path.join(root,'db_storage/contact'),{recursive:true});await fs.mkdir(path.join(root,'db_storage/message'),{recursive:true});await fs.writeFile(path.join(root,'db_storage/contact/contact.db'),'metadata-fixture');}
test('finds real account folder structure, excludes incomplete/symlink directories and normalizes db_storage',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'weave-discovery-'));
 try{const base=defaultLocations(home)[0],one=path.join(base,'test-account-a');await account(one);await fs.mkdir(path.join(base,'all_users'));const outside=path.join(home,'unrelated');await account(outside);await fs.symlink(outside,path.join(base,'shortcut'));
  let r=await discoverWeChat(home);assert.equal(r.accounts.length,1);assert.equal(r.accounts[0].root,await fs.realpath(one));assert.equal(r.defaultPath,base);assert.deepEqual(r.warnings,[]);assert.equal((await normalizeSelection(path.join(one,'db_storage'))).root,await fs.realpath(one));await assert.rejects(normalizeSelection(base),/不是受支持/);
  const two=path.join(base,'test-account-b');await account(two);r=await discoverWeChat(home);assert.equal(r.accounts.length,2);assert.deepEqual(new Set(r.accounts.map(a=>a.label)),new Set(['test-account-a','test-account-b']));
 }finally{await fs.rm(home,{recursive:true,force:true});}
});
test('missing common locations returns empty detection instead of selecting unrelated folders',async()=>{const home=await fs.mkdtemp(path.join(os.tmpdir(),'weave-discovery-empty-'));try{const r=await discoverWeChat(home);assert.deepEqual(r.accounts,[]);assert.deepEqual(r.warnings,[]);}finally{await fs.rm(home,{recursive:true,force:true});}});
