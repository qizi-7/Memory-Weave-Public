# Testing source changes

On macOS ARM64, install Xcode Command Line Tools and Node.js 26. Build SQLCipher 4.6.1's amalgamation as shown in [README.md](README.md), and export `SQLCIPHER_DIR` to the directory containing `sqlite3.c` and `sqlite3.h`. Run from a Git checkout:

```sh
cd app
npm ci --ignore-scripts
npm test
npm run build
```

`npm test` first runs `scripts/build-native.cjs --test`, which builds the SQLCipher reader and synthetic fixture helpers, then runs `node --test tests/*.test.cjs`. `npm run build` checks TypeScript and builds the renderer; `build-info.cjs` records the checkout commit. This does not build or test an installer.

| Change | Tests to start with (from `app/`) |
| --- | --- |
| Import, native reader, WAL and incremental sync | `tests/wechat.test.cjs`, `tests/wechat-profile-identity.test.cjs`, `tests/auto-sync.test.cjs`, `tests/sync-reliability.test.cjs` |
| Store and derived views | `tests/store.test.cjs`, `tests/archive-reliability.test.cjs`, `tests/archive-views.test.cjs` |
| Media and payload boundaries | `tests/message-content.test.cjs`, `tests/media-resource.test.cjs`, `tests/media-generation.test.cjs`, `tests/media-restore.test.cjs`, `tests/video-location.test.cjs` |
| AI references and stale index protection | `tests/ai.test.cjs` uses a local HTTP fixture and synthetic messages. |
| Profile separation | `tests/next-isolation.test.cjs` checks temporary legacy/Next paths and data sentinels. |

After the native fixture build, narrow the loop with e.g. `node --test tests/media-resource.test.cjs`. For Electron smoke tests install the locked Electron binary explicitly as documented in the README, build the native reader and renderer, then use `node scripts/smoke-archive-views.cjs` from `app/`. It creates a temporary synthetic profile. Other smoke and benchmark scripts have their own arguments and requirements: inspect them before executing, especially scripts with `live` in their names. Do not use a production profile or real archive.

Report the tested commit, platform, command and results. Distinguish source checks, synthetic native tests, Electron smoke runs and real-environment validation. Passing synthetic tests does not establish compatibility with all WeChat account formats, real Alpha databases, production-size history, or real model inference.
