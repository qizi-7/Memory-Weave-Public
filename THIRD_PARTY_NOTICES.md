# 第三方来源与许可

根目录 MIT 许可证适用于有权授权的 Memory Weave 项目代码和文档。下列第三方材料适用其各自的条款。

| 材料 | 用途与许可 |
| --- | --- |
| [xxk8/wechat-emojis](https://github.com/xxk8/wechat-emojis/tree/7546b8c294095c9d18adb72cbde96abdaf4ba980) | 文本表情短代码名称数据用于匹配。仓库保留[上游 MIT 通知及图片例外](app/resources/licenses/wechat-emoji-vocabulary.txt)，不含上游图片或腾讯表情资源。 |
| [SQLCipher v4.6.1](https://github.com/sqlcipher/sqlcipher/tree/v4.6.1) | 原生只读工具的构建依赖。源代码由构建者单独下载，保留 [SQLCipher 通知](app/resources/licenses/SQLCipher.txt)。 |
| React、React DOM、sax、silk-wasm；Electron、Vite、TypeScript 等构建工具 | 仅提交 npm 清单与锁文件，不提交依赖树、Electron 二进制或 WASM。React / React DOM、silk-wasm、Electron 和 Vite 为 MIT，sax 为 BlueOak-1.0.0，TypeScript 为 Apache-2.0。精确版本、来源、完整性和许可证标记见 [app/package-lock.json](app/package-lock.json)。标记不能替代对分发包中原始许可证及 NOTICE 的核查。 |
| [Tencent MMKV 格式说明](https://github.com/Tencent/mmkv/wiki/design_eng) | 本地账号配置解析依赖项目既有合成夹具与格式约定。参考公开的序列化背景，没有复制或编译 MMKV 的实现。 |

源代码快照不包含 TraceMemo 的实现、Ollama、模型、SQLCipher 源码、真实用户档案或安装包。Ollama 和模型由用户单独取得，适用其各自的许可及模型条款。安装包分发前需按实际内容汇总 Electron、Chromium、Node.js、npm 模块（含 WASM 的上游组件）和 SQLCipher 的许可证、版权与 NOTICE，并检查是否需要同时提供其他材料。
