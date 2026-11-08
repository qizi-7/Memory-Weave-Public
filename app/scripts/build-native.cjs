const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {execFileSync}=require('node:child_process');

if(process.platform!=='darwin'||process.arch!=='arm64'){
 throw Error('构建原生读取器需要 macOS ARM64 与 Xcode Command Line Tools。');
}
const app=path.resolve(__dirname,'..');
const source=path.resolve(process.env.SQLCIPHER_DIR||path.join(app,'../research/sqlcipher'));
const amalgamation=path.join(source,'sqlite3.c');
const header=path.join(source,'sqlite3.h');
if(!fs.existsSync(amalgamation)||!fs.existsSync(header)){
 throw Error('缺少 SQLCipher 4.6.1 的 sqlite3.c/sqlite3.h。请按 README 生成 amalgamation 或设置 SQLCIPHER_DIR。');
}
const tests=process.argv.includes('--test');
const build=path.join(app,'native/.build');
fs.mkdirSync(build,{recursive:true});
const compile=args=>execFileSync('xcrun',['clang',...args],{stdio:'inherit'});
const flags=['-O2','-DSQLITE_HAS_CODEC','-DSQLITE_TEMP_STORE=2','-DSQLCIPHER_CRYPTO_CC','-DSQLITE_OS_UNIX=1'];
const object=path.join(build,'sqlcipher.o');
const hash=createHash('sha256');
for(const input of [amalgamation,header,__filename])hash.update(fs.readFileSync(input));
const digest=hash.digest('hex');
const stamp=path.join(build,'sqlcipher.sha256');
const rebuild=!fs.existsSync(object)||!fs.existsSync(stamp)||fs.readFileSync(stamp,'utf8')!==digest;
if(rebuild){
 compile([...flags,'-c',amalgamation,'-o',object]);
 fs.writeFileSync(stamp,digest);
}
const targets=tests
 ? [['native/reader.c','native/.build/wechat-reader'],['tests/encrypted-fixture.c','native/.build/encrypted-fixture'],['tests/wal-writer.c','native/.build/wal-writer']]
 : [['native/reader.c','resources/native/wechat-reader']];
for(const [input,output] of targets){
 const inputFile=path.join(app,input),outputFile=path.join(app,output);
 if(!rebuild&&fs.existsSync(outputFile)&&fs.statSync(outputFile).mtimeMs>=Math.max(fs.statSync(inputFile).mtimeMs,fs.statSync(object).mtimeMs))continue;
 fs.mkdirSync(path.dirname(outputFile),{recursive:true});
 compile([...flags,'-I',source,inputFile,object,'-framework','Security','-framework','CoreFoundation','-o',outputFile]);
}
