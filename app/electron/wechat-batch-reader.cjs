const {spawn}=require('node:child_process');

const responseLimit=16*1024*1024;
function openBatchReader(helper,file,key,profile,{timeoutMs=45000}={}){
 if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>45000)throw Error('读取超时参数无效');
 const child=spawn(helper,[file,'--private-batch'],{stdio:['pipe','pipe','pipe']});
 const exited=new Promise(resolve=>child.once('close',resolve));
 let pending,closed=false,nativeCode,lastResponseBytes=0;
 const fail=(message,code)=>{
  closed=true;
  if(!pending)return;
  const {reject,rows,bytes,timer}=pending;
  pending=null;
  clearTimeout(timer);
  reject(Object.assign(Error(message),{code,rows:rows.length,bytes}));
 };
 child.stderr.on('data',chunk=>{
  const text=String(chunk);
  if(text.includes('ROW_BYTES'))nativeCode='ROW_BYTES';
  else if(text.includes('PAGE_BYTES')||text.includes('BYTE_LIMIT'))nativeCode='PAGE_BYTES';
  else if(text.includes('KEY_OR_SCHEMA_OR_QUERY_FAILED'))nativeCode='NATIVE_QUERY';
  else if(text.includes('READ_FAILED')&&!nativeCode)nativeCode='NATIVE_READ';
 });
 child.stdin.on('error',()=>fail('数据库读取连接已断开。','NATIVE_PIPE'));
 child.on('error',()=>fail('无法启动数据库读取连接。','NATIVE_SPAWN'));
 child.on('close',()=>fail('数据库读取连接已退出。',nativeCode||'NATIVE_EXIT'));
 // The helper writes UTF-8 NDJSON delimited only by LF. U+2028/2029 belong to the JSON payload.
 child.stdout.on('data',chunk=>{
  const request=pending;
  if(!request)return;
  request.bytes+=chunk.length;
  if(request.bytes>responseLimit){
   fail('数据库查询超过单批响应字节上限。','PAGE_BYTES');
   child.kill();
   return;
  }
  let start=0;
  while(start<chunk.length){
   const end=chunk.indexOf(10,start);
   if(end<0){request.parts.push(chunk.subarray(start));return;}
   request.parts.push(chunk.subarray(start,end));
   let line;
   try{line=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(request.parts));}catch{fail('数据库桥接返回无效编码。','BRIDGE_UTF8');child.kill();return;}
   request.parts=[];
   start=end+1;
   if(line==='END'){
    clearTimeout(request.timer);
    pending=null;
    lastResponseBytes=request.bytes;
    request.resolve(request.rows);
    return;
   }
   try{request.rows.push(JSON.parse(line));}
   catch{
    fail('数据库桥接返回了无效的 JSON 记录。','BRIDGE_JSON');
    child.kill();
    return;
   }
  }
 });
 child.stdin.write(key+'\n'+profile+'\n');
 return {
  get responseBytes(){return lastResponseBytes},
  query(sql){
   if(closed||pending||/[\r\n]/.test(sql))return Promise.reject(Object.assign(Error('数据库查询连接或参数无效。'),{code:'BRIDGE_STATE'}));
   return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{fail('数据库读取超时。','NATIVE_TIMEOUT');child.kill();},timeoutMs);
    pending={resolve,reject,timer,rows:[],bytes:0,parts:[]};
    child.stdin.write(sql+'\n');
   });
  },
  close(){
   child.stdin.end();
   return exited;
  }
 };
}
module.exports={openBatchReader};
