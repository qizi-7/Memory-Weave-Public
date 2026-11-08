const {test}=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const {validatePack,EmojiPack}=require('../electron/text-emoji-pack.cjs');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const bytes=Buffer.from('89504e470d0a1a0a00000000','hex');
const pack={version:1,source:'synthetic fixture',license:'synthetic permission',assets:[{name:'[捂脸]',mime:'image/png',base64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')}]};
const decode=()=>({width:100,height:100});
test('authorized local pack persists and revalidates across restart without external requests',async()=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'mw-emoji-'));try{const file=path.join(root,'fixture.json');await fs.writeFile(file,JSON.stringify(pack));const a=new EmojiPack(root,decode);await assert.rejects(a.import(file,false));const assets=await a.import(file,true);assert.deepEqual(await new EmojiPack(root,decode).get(),assets);assert.equal(Object.keys(assets).length,1);assert.match(assets['[捂脸]'],/^data:image\/png;base64,/);assert.equal((await fs.stat(path.join(root,'authorized-text-emoji.json'))).mode&0o777,0o600)}finally{await fs.rm(root,{recursive:true,force:true})}});
test('pack rejects wrong aliases, duplicate names, hash errors, invalid headers, decode failure and oversized dimensions',()=>{
 for(const item of [{...pack.assets[0],name:'[项目名称]'}, {...pack.assets[0],sha256:'0'.repeat(64)},{...pack.assets[0],mime:'image/webp'}])assert.throws(()=>validatePack({...pack,assets:[item]},decode));
 assert.throws(()=>validatePack({...pack,assets:[...pack.assets,...pack.assets]},decode));assert.throws(()=>validatePack(pack,()=>null));assert.throws(()=>validatePack(pack,()=>({width:1024,height:100})));
});
