// Walk GIF blocks rather than searching compressed image bytes for GCE markers.
function gifTiming(bytes,scale=1){
 if(!Buffer.isBuffer(bytes)||bytes.length<14||!/^GIF8[79]a$/.test(bytes.subarray(0,6).toString())||!Number.isFinite(scale)||scale<0.5||scale>3)throw Error('无效的 GIF 时间校准参数。');
 const output=Buffer.from(bytes),delays=[];let pos=13,pending=null,loop=null,frames=0;
 const need=n=>{if(pos+n>bytes.length)throw Error('GIF 数据截断。')};
 const blocks=()=>{while(true){need(1);const n=bytes[pos++];if(!n)return;need(n);pos+=n}};
 if(bytes[10]&128)pos+=3*(1<<((bytes[10]&7)+1));
 while(pos<bytes.length){need(1);const kind=bytes[pos++];
  if(kind===0x3b){if(pos!==bytes.length||!frames)throw Error('GIF 结束标记无效。');return{bytes:output,frames,delays,durationMs:delays.reduce((a,b)=>a+b,0),loop,timingSource:'decoded-gif',originalTimingVerified:false}}
  if(kind===0x21){need(1);const label=bytes[pos++];
   if(label===0xf9){need(6);if(bytes[pos]!==4||bytes[pos+5]!==0)throw Error('GIF 控制块无效。');pending={offset:pos+2,delay:bytes.readUInt16LE(pos+2)};pos+=6;}
   else if(label===0xff){need(1);const n=bytes[pos++];need(n);const application=bytes.subarray(pos,pos+n).toString();pos+=n;if(application==='NETSCAPE2.0'){need(4);if(bytes[pos]===3&&bytes[pos+1]===1)loop=bytes.readUInt16LE(pos+2)}blocks();}
   else blocks();
  }else if(kind===0x2c){need(9);const flags=bytes[pos+8];pos+=9;if(flags&128)pos+=3*(1<<((flags&7)+1));need(1);pos++;blocks();frames++;if(frames>600)throw Error('GIF 帧数超限。');
   if(scale!==1&&(!pending||!pending.delay))throw Error('GIF 没有可靠的已解码帧延时，不能校准。');
   const delay=pending?Math.max(scale===1?0:1,Math.round(pending.delay*scale)):0;if(pending)output.writeUInt16LE(Math.min(65535,delay),pending.offset);delays.push(delay*10);pending=null;
   if(delays.reduce((a,b)=>a+b,0)>120000)throw Error('GIF 动画时长超限。');
  }else throw Error('未知的 GIF 数据块。');
 }
 throw Error('GIF 缺少结束标记。');
}
module.exports={gifTiming};
