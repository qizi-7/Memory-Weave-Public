# 首版真实归档导入契约

应用不内置聊天数据。请把你有权处理的导出文件转换为下列结构；此格式目前不是微信原生格式，也不是自动兼容所有 ChatLab / Alpha 导出。

```typescript
interface ArchiveV1 {
  version: 1
  account: { id: string; name: string }
  contacts: Array<{ id: string; name: string }>
  messages: Array<{
    id: string                  // 账号内唯一稳定消息 ID
    chat: string                // 必须对应 contacts.id
    sender: string
    timestamp: number           // Unix 秒，整数
    text: string
    outgoing: boolean
    kind: 'text' | 'image' | 'video' | 'voice' | 'file' | 'link' | 'system'
  }>
}
```

首版单文件上限 50 MB；没有附件路径/解密和媒体预览。不读取输入文件外的任何路径。重复 id 不覆盖已导入的原记录；非法字段使整个导入失败，事务失败会回滚。

导出 JSON 是 effective message 行（含原文 original、编辑后 text、note 等），用于检查和后续处理；当前不是可直接再次导入的 ArchiveV1。Markdown 也不保证双向转换。

SQLite 工作库在 Electron userData 下 workspace.sqlite。当前本地数据库未加密，不能替代磁盘加密或应用锁。工作库仅在本机存储，不向模型或第三方上传。
