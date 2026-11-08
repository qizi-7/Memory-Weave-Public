const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createCipheriv}=require('node:crypto');
const {readLocalAccountIdentity,accountDirectoryBelongsToIdentity}=require('../electron/wechat-profile-identity.cjs');

const field=b=>{
 const value=Buffer.from(b);
 const length=value.length<128?[value.length]:[(value.length&127)|128,value.length>>7];
 return Buffer.concat([Buffer.from(length),value]);
};
const pair=(key,value)=>Buffer.concat([field(key),field(field(value))]);
function encode(records,allocated=0){
 const header=Buffer.alloc(4);
 header.writeUInt32LE(records.length);
 const cipher=createCipheriv('aes-128-cfb',Buffer.from('xwechat_crypt_key').subarray(0,16),Buffer.alloc(16));
 return Buffer.concat([header,cipher.update(records),cipher.final(),Buffer.alloc(allocated)]);
}
function profile(t){
 const parent=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'mw-profile-fixture-')));
 t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
 const file=path.join(parent,'all_users','config','global_config');
 fs.mkdirSync(path.dirname(file),{recursive:true});
 return {parent,file};
}

test('profile identifies the selected account and reads a multi-byte length nickname without using padding',t=>{
 const {parent,file}=profile(t);
 const wxid='wxid_synthetic',nickname='合成昵称'.repeat(18);
 const data=Buffer.concat([Buffer.from([0]),pair('mmkv_key_user_name',wxid),pair('mmkv_key_nick_name',nickname)]);
 fs.writeFileSync(file,encode(data,100));
 const identity=readLocalAccountIdentity(parent);
 assert.deepEqual(identity,{wxid,nickname});
 assert.ok(accountDirectoryBelongsToIdentity(wxid,identity.wxid));
 assert.ok(accountDirectoryBelongsToIdentity(wxid+'_4a9B',identity.wxid));
 assert.equal(accountDirectoryBelongsToIdentity(wxid+'_other_1234',identity.wxid),false);
 assert.equal(accountDirectoryBelongsToIdentity(wxid+'-1',identity.wxid),false);
});

test('profile rejects truncation, a deleted identity and symlinked config instead of guessing the account',t=>{
 const {parent,file}=profile(t);
 const key='mmkv_key_user_name',record=pair(key,'test-self');
 const data=encode(record);
 fs.writeFileSync(file,data.subarray(0,-1));
 assert.equal(readLocalAccountIdentity(parent),null);
 fs.writeFileSync(file,encode(Buffer.concat([record,field(key),field('')])));
 assert.equal(readLocalAccountIdentity(parent),null);
 fs.unlinkSync(file);
 const target=path.join(parent,'other-config');
 fs.writeFileSync(target,data);
 fs.symlinkSync(target,file);
 assert.equal(readLocalAccountIdentity(parent),null);
});
