const sax = require('sax');

const labels = {
  image: '图片', video: '视频', voice: '语音', sticker: '动画表情', file: '文件',
  quote: '引用消息', share: '链接', miniProgram: '小程序', transfer: '转账',
  system: '系统消息', redPacket: '微信红包', forward: '合并转发', unknown: '暂不支持的消息'
};
const numeric = {1:'text',3:'image',34:'voice',43:'video',47:'sticker',49:'share',10000:'system',10002:'system'};
const tags = {img:'image', videomsg:'video', voicemsg:'voice', emoji:'sticker', sticker:'sticker', appmsg:'share', sysmsg:'system', sysmsgtemplate:'system', content_template:'system', patinfo:'system'};
const maxPayload = 256 * 1024;
const wireFields = /\b(?:aeskey\w*|cdn(?:thumb|mid|big)\w*|encrypturl|encrypver|md5|base64)\s*["']?\s*[:=]/i;
function safeText(value, limit = maxPayload) {
  const text = value?.trim() || '';
  if (/<\/?[a-z!?][^>]*>|&(?:lt|#0*60|#x0*3c);\/?[a-z!?]/i.test(text) ||
      wireFields.test(text) || /data:[\w/+.-]+;base64,/i.test(text) ||
      (/^[A-Za-z0-9+/]{120,}={0,2}$/.test(text) && /[a-z]/.test(text) && /[A-Z]/.test(text) && /[0-9+/=]/.test(text)) ||
      /^[a-f0-9]{32,}$/i.test(text) ||
      /^\s*[\[{][\s\S]*"\$hex"\s*:/.test(text)) return '';
  if (/^[{\[]/.test(text)) {
    try { JSON.parse(text); return ''; } catch { /* Ordinary prose can start with a bracket. */ }
  }
  return text.slice(0, limit);
}
function readXml(text) {
  const stack = [], roots = [];
  const parser = sax.parser(true, {strictEntities:true});
  parser.ondoctype = () => { throw Error('doctype'); };
  parser.onerror = error => { throw error; };
  let count = 0;
  parser.onopentag = tag => {
    if (++count > 4096 || stack.length >= 32) throw Error('complexity');
    const node = {name:tag.name.toLowerCase(), attrs:Object.create(null), children:[], text:''};
    for (const [key,value] of Object.entries(tag.attributes)) node.attrs[key.toLowerCase()] = value;
    (stack.at(-1)?.children || roots).push(node);
    stack.push(node);
  };
  parser.onclosetag = () => stack.pop();
  parser.ontext = parser.oncdata = value => { if (stack.length) stack.at(-1).text += value; };
  parser.write(text).close();
  if (roots.length !== 1) throw Error('root');
  return roots[0];
}
const child = (node, name) => node?.children.find(item => item.name === name);
const value = (node, name) => child(node, name)?.text.trim() || '';
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : undefined;
const hashesOf = (...values) => [...new Set(values.filter(v => typeof v === 'string' && /^[0-9a-f]{32}$/i.test(v)).map(v => v.toLowerCase()))];
function archiveType(type) {
  if (type === 'link') return 'share';
  if (/^\d+$/.test(String(type))) return numeric[Number(BigInt(type) & 0xffffffffn)] || 'unknown';
  return type === 'text' || Object.hasOwn(labels, type) ? type : 'unknown';
}
function fallback(type, reason) {
  return {type, label:labels[type], reason};
}
function parseWeChatMessage(raw, type) {
  type = archiveType(type);
  const source = typeof raw === 'string' ? raw.trim() : '';
  if (source.length > maxPayload) return fallback(type === 'text' ? 'unknown' : type, 'payloadTooLarge');
  let xml = source.replace(/^[\w@.-]{1,200}:\r?\n(?=\s*(?:<|&lt;))/i, '').trimStart();
  if (/^&lt;/i.test(xml)) {
    xml = xml.replace(/&(?:lt|gt|amp|quot|apos);/g, entity => ({'&lt;':'<','&gt;':'>','&amp;':'&','&quot;':'"','&apos;':"'"})[entity]);
  }
  if (!/^<(?:\?|!|[a-z])/i.test(xml)) {
    if (type === 'text' || type === 'system') {
      const text = safeText(source);
      if (text || !source) return {type, text, label:labels[type]};
      return fallback('unknown', 'unsafeText');
    }
    if (type === 'voice' && !source) return {type,label:labels[type]};
    if (type === 'image' || type === 'sticker') {
      let image = {};
      if (source.startsWith('{')) {
        try { image = JSON.parse(source) || {}; } catch { return fallback(type,'invalidJson'); }
      }
      const hashes = hashesOf(image.md5, image.content, source);
      const datName = [image.datName,image.imageDatName].find(name => typeof name === 'string' && /^[a-f0-9]{32}(?:_[a-z0-9]{1,12})?(?:\.dat)?$/i.test(name));
      if (hashes.length || datName) return {type,label:labels[type],hashes,datName};
    }
    return fallback(type, source ? 'unsupportedPayload' : 'emptyPayload');
  }
  // Identify known envelopes even when their XML is malformed, without exposing it.
  const signature = /^\s*(?:<\?xml[^?]*\?>\s*)?(?:<msg\b[^>]*>\s*)?<(img|videomsg|voicemsg|emoji|sticker|appmsg|sysmsg|sysmsgtemplate|content_template|patinfo)\b/i.exec(xml)?.[1];
  if (signature && (['text','system','unknown'].includes(type) || signature.toLowerCase() === 'appmsg')) type = tags[signature.toLowerCase()];
  let root;
  try { root = readXml(xml); } catch { return fallback(type === 'text' ? 'unknown' : type,'invalidXml'); }
  const node = root.name === 'msg' ? root.children.find(item => Object.hasOwn(tags,item.name)) : root;
  if (!node || !Object.hasOwn(tags,node.name)) return fallback(type === 'text' ? 'unknown' : type,'unsupportedXml');
  type = tags[node.name];
  const a = node.attrs;
  const hashes = hashesOf(a.md5,a.newmd5,a.rawmd5,a.cdnthumbmd5,value(node,'md5'));
  if (type === 'image' || type === 'sticker') return {type,label:labels[type],hashes,
    ...(type==='sticker'?{remoteHint:[a.cdnurl,a.encrypturl,a.externurl,a.thumburl].some(v=>/^https?:\/\//i.test(v||''))}:{})};
  if (type === 'voice' || type === 'video') {
    const duration = positive(type === 'voice' ? a.voicelength : a.playlength);
    return {type,label:labels[type],hashes,duration:duration && (type === 'voice' ? duration / 1000 : duration)};
  }
  const clean = (key, limit = 300, item = node) => safeText(value(item,key),limit);
  if (type === 'system') {
    const text = systemText(node);
    return {type,label:labels[type],text,reason:text ? undefined : 'unsupportedSystem'};
  }
  const appType = value(node,'type');
  const ref = child(node,'refermsg');
  type = ref ? 'quote' : ({6:'file',74:'file',33:'miniProgram',36:'miniProgram',57:'quote',
    2000:'transfer',2001:'redPacket',19:'forward',47:'sticker'})[appType] || 'share';
  const article = child(child(child(node,'mmreader'),'category'),'item');
  const title = clean('title') || clean('title',300,article);
  const description = clean('des',500) || clean('digest',500,article);
  const sourceName = clean('sourcedisplayname') || clean('appname',300,child(root,'appinfo'));
  const content = {type,label:labels[type],title,description,sourceName};
  if (type === 'file') content.bytes = positive(value(child(node,'appattach'),'totallen'));
  if (type === 'quote') {
    const quoted = parseQuoted(ref);
    content.quote = [clean('displayname',80,ref),quoted].filter(Boolean).join(' · ');
  }
  if (type === 'transfer') content.description = clean('feedesc',80,child(node,'wcpayinfo')) || description;
  if (type === 'sticker') {
    const a=child(node,'emoji')?.attrs||{};
    content.hashes=hashesOf(a.md5,a.newmd5,value(node,'md5'));
    content.remoteHint=[a.cdnurl,a.encrypturl,a.externurl,a.thumburl].some(v=>/^https?:\/\//i.test(v||''));
  }
  if (!title && !content.description && !content.quote && !content.hashes?.length && ['share','file','quote'].includes(type)) content.reason = 'missingCardMetadata';
  return content;
}
function systemText(node) {
  const recall = child(node,'revokemsg');
  if (recall) return safeText(value(recall,'replacemsg'),500) || '有一条消息已撤回';
  const wrapper = node.name === 'sysmsgtemplate' ? node : child(node,'sysmsgtemplate');
  const template = node.name === 'content_template' ? node :
    child(wrapper,'content_template') || child(node,'content_template');
  if (template) {
    const plain = safeText(value(template,'plain'),500);
    if (plain) return plain;
    const names = new Map();
    for (const link of child(template,'link_list')?.children || []) {
      if (link.name !== 'link' || link.attrs.hidden === '1') continue;
      const people = (child(link,'memberlist')?.children || [])
        .map(member=>safeText(value(member,'nickname'),80)).filter(Boolean);
      names.set(link.attrs.name,people.join('、') || safeText(value(link,'title') || value(link,'text'),80));
    }
    const rendered = value(template,'template').replace(/\$([A-Za-z0-9_]+)\$/g,(_,key)=>names.get(key)||'');
    return safeText(rendered.replace(/\s+/g,' '),500);
  }
  const notice = child(node,'delchatroommember') || child(node,'patinfo');
  return safeText(value(notice,'plain') || value(notice,'text') || value(node,'plain') || value(node,'text') || node.text,500);
}
function parseQuoted(ref) {
  const body = value(ref,'content');
  const type = archiveType(value(ref,'type'));
  return type === 'text' ? safeText(body,260) || '引用消息' : labels[type] || '引用消息';
}
function messageContent(row) {
  return parseWeChatMessage(row.text, row.original !== undefined && row.text !== row.original ? 'text' : row.kind);
}
function buildMessagePreview(content, limit = 160) {
  const title = content.title || content.quote;
  const summary = content.text || (content.label ? '['+content.label+']'+(title ? ' '+title : '') : '');
  const normalized = summary.replace(/\s+/g,' ').trim();
  const characters = Array.from(normalized.slice(0,(limit+1)*2));
  return characters.length > limit ? characters.slice(0,limit).join('')+'…' : normalized;
}
function presentMessage(row) {
  const {hashes,datName,remoteHint,...contentData} = messageContent(row);
  return {...row,displayContent:buildMessagePreview(contentData),contentData};
}
function publicMessage({text,original,...message}) { return message; }
module.exports = {parseWeChatMessage,messageContent,buildMessagePreview,presentMessage,publicMessage};
