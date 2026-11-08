# Memory Weave

Memory Weave Next 0.3.9 是一款面向 macOS ARM64 的本地微信档案工具。可导入 JSON 或用户授权的微信数据库副本，按账号浏览、搜索、编辑备注和导出；支持微信历史和增量同步，以及部分本地媒体预览。对格式不匹配或无法验证的媒体保留原消息和提示。项目与微信及其他档案工具无隶属关系。

## 源码分析入口

- [ARCHITECTURE.md](ARCHITECTURE.md)：进程边界、数据流及主要调用链。
- [CODE_MAP.md](CODE_MAP.md)：源码路径、模块索引与入口。
- [TESTING.md](TESTING.md)：构建、合成测试和验证范围。
- [AI_ANALYSIS_GUIDE.md](AI_ANALYSIS_GUIDE.md)：按公开提交 SHA 审查、引用和比较源码的方法。

公开版本以 Git 提交为准。分析时固定完整 SHA；如果已发布正式源码标签，也可通过标签定位相同版本。

## 构建与测试

需要 macOS ARM64、Xcode Command Line Tools、Node.js 26 和 npm。先在**路径不含空格**的位置准备 SQLCipher 4.6.1 的 amalgamation：

```sh
sqlcipher_dir="$(mktemp -d /tmp/mw-sqlcipher.XXXXXXXX)"
git clone --depth 1 --branch v4.6.1 https://github.com/sqlcipher/sqlcipher.git "$sqlcipher_dir"
(cd "$sqlcipher_dir" && ./configure --with-crypto-lib=commoncrypto --disable-shared --enable-tempstore=yes && make sqlite3.c)
export SQLCIPHER_DIR="$sqlcipher_dir"
```

从 Git checkout 运行：

```sh
cd app
npm ci
# 若 npm 阻止 Electron 安装脚本，显式下载锁定版本的 Electron。
test -f node_modules/electron/path.txt || node node_modules/electron/install.js
npm test
npm run build:native
npm run build
npm start -- "--validation-user-data=$(mktemp -d /tmp/mw-validation.XXXXXXXX)"
```

测试只使用临时或内存数据库、合成媒体及本机模拟 HTTP 服务。上面的启动命令使用临时验证资料，禁止访问真实微信源；普通启动会打开 Next 自己的本机工作目录。查看 [JSON 导入格式](docs/04-import-format.md) 和 [本地文本表情资源](docs/39-text-emoji-local-pack.md)。

## 本地 AI

语义检索和问答依赖用户自行安装的 Ollama，以及 `embeddinggemma:latest` 和 `qwen3:0.6b`。以仅监听本机的方式启动，并从另一个终端按所选模型条款下载模型：

```sh
OLLAMA_HOST=127.0.0.1:11449 OLLAMA_NO_CLOUD=1 ollama serve
```

```sh
OLLAMA_HOST=127.0.0.1:11449 ollama pull embeddinggemma:latest
OLLAMA_HOST=127.0.0.1:11449 ollama pull qwen3:0.6b
```

应用只向该本机端点请求推理。已有完整且模型、修订一致的索引仍可读取；用户主动重新建立索引时才换用新分块。分块 ID 和检索排序可能随重建变化，引用仍指向原消息。安装包不附带模型或 Ollama。用户自行下载模型之前应查看相应条款。

## 数据与发行

仅导入你有权处理的档案。原库只读；应用把档案、编辑和索引保存在自己的本机工作库。应用内可手动指定本人微信 ID，供本机账号配置不受支持时使用。项目不附带微信数据库、媒体、表情图片或用户日志。

本仓库源码候选以 MIT 许可覆盖有权授权的 Memory Weave 部分；第三方内容保留原许可和声明，见 [第三方许可](THIRD_PARTY_NOTICES.md)。本地打包脚本用于测试，公开分发 .app 或 .dmg 前需要独立审核安装包内容和通知文件。
