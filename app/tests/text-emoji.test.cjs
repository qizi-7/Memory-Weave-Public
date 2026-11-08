const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const ts=require('typescript'),React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
// Compile the actual renderer source; synthetic text only, no network or archive access.
function renderer(){const filename=path.resolve(__dirname,'../src/text-emoji.tsx'),mod=new Module(filename);mod.filename=filename;mod.paths=Module._nodeModulePaths(path.dirname(filename));mod._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,esModuleInterop:true,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,filename);return mod.exports}
test('versioned WeChat aliases never substitute approximate Unicode or unknown bracket text',()=>{
 const {TextEmoji,wechatTextEmojiAliases}=renderer();assert.equal(wechatTextEmojiAliases.version,2);
 for(const text of ['[捂脸]','[呲牙]','[微笑]','[旺柴]','[捂脸][呲牙]中文[旺柴]','[项目名称][文件名]','引用：[微笑]']){
 const html=renderToStaticMarkup(React.createElement(TextEmoji,{text}));assert.equal(html.replace(/<[^>]+>/g,''),text);assert.doesNotMatch(html,/role="img"|<img|🤦|😁|🙂/);
 }
 assert.equal(Object.keys(wechatTextEmojiAliases.aliases).length,109);
});
