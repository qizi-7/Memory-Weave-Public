const {createHash}=require('node:crypto');
const {messageContent,buildMessagePreview}=require('./message-content.cjs');

// Keep the archive's text and timestamps intact; these records are only for retrieval.
function normalizeKnowledgeMessage({accountId,conversationId,messageId,createTime,senderName,senderId,kind,text,original,note}){
 const content=messageContent({text,original,kind:kind||'text'});
 const readable=content.text||buildMessagePreview(content)||'[消息]';
 const body=readable+(note?'\n备注：'+note:'');
 return {accountId,conversationId,messageId,createTime,
  label:String(senderName||senderId||'未知发送者').replace(/\s+/gu,' ').trim(),
  body:body.replace(/\r\n?/g,'\n').trim()};
}

function chunkConversation(messages,{version,maxGapMs,maxMessages,maxCharacters}){
 const chunks=[];
 let lines=[],ids=new Set(),length=0,last;
 function flush(){
  if(!last||!lines.length)return;
  const text=lines.join('\n'),messageIds=[...ids];
  const chunkId=createHash('sha256').update(JSON.stringify([
   version,last.accountId,last.conversationId,chunks.length,messageIds,text
  ])).digest('hex');
  chunks.push({chunkId,conversationId:last.conversationId,text,messageIds});
  lines=[];ids=new Set();length=0;
 }
 for(const message of messages){
  if(last&&(message.accountId!==last.accountId||message.conversationId!==last.conversationId||
    message.createTime-last.createTime>maxGapMs))flush();
  last=message;
  const line=(message.label?message.label+': ':'')+message.body;
  let start=0;
  while(start<line.length){
   if(!ids.has(message.messageId)&&ids.size===maxMessages)flush();
   const separator=lines.length?1:0;
   const available=maxCharacters-length-separator;
   // Keep a short message whole. Split oversized messages without dropping their tails.
   if(lines.length&&(available<=0||line.length-start>available)){flush();continue;}
   let end=Math.min(start+available,line.length);
   if(end<line.length&&/[\uDC00-\uDFFF]/u.test(line[end]))end--;
   if(end<=start)throw RangeError('知识分块长度不足');
   lines.push(line.slice(start,end));ids.add(message.messageId);length+=end-start+separator;
   start=end;
   if(start<line.length)flush();
  }
 }
 flush();
 return chunks;
}
module.exports={normalizeKnowledgeMessage,chunkConversation};
