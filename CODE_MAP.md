# Source map

Browse the paths below at the public commit being reviewed. The list covers all tracked files at this documentation baseline, including original TypeScript and synthetic fixtures. For flow and test context see [ARCHITECTURE.md](ARCHITECTURE.md) and [TESTING.md](TESTING.md). At another revision run `git ls-tree -r --name-only <sha>` for its exact inventory.

## Renderer and web entry

- [app/src/account-settings.tsx](app/src/account-settings.tsx)
- [app/src/archive-pages.tsx](app/src/archive-pages.tsx)
- [app/src/integrations.tsx](app/src/integrations.tsx)
- [app/src/main.tsx](app/src/main.tsx) — React App and renderer entry
- [app/src/message-body.tsx](app/src/message-body.tsx)
- [app/src/style.css](app/src/style.css)
- [app/src/text-emoji.tsx](app/src/text-emoji.tsx)

## Electron, persistence, and integration

- [app/electron/ai.cjs](app/electron/ai.cjs) — local AI indexing and retrieval
- [app/electron/app-identity.cjs](app/electron/app-identity.cjs)
- [app/electron/archive-backup.cjs](app/electron/archive-backup.cjs)
- [app/electron/archive-projection.cjs](app/electron/archive-projection.cjs)
- [app/electron/archive-view-worker.cjs](app/electron/archive-view-worker.cjs) — archive read queries
- [app/electron/archive-views.cjs](app/electron/archive-views.cjs)
- [app/electron/auto-sync.cjs](app/electron/auto-sync.cjs)
- [app/electron/gif-timing.cjs](app/electron/gif-timing.cjs)
- [app/electron/knowledge-text.cjs](app/electron/knowledge-text.cjs) — normalization and chunk construction
- [app/electron/latest-stats.cjs](app/electron/latest-stats.cjs)
- [app/electron/local-runtime.cjs](app/electron/local-runtime.cjs)
- [app/electron/main.cjs](app/electron/main.cjs) — IPC routes, source grants and media protocol
- [app/electron/media-restore.cjs](app/electron/media-restore.cjs)
- [app/electron/message-content.cjs](app/electron/message-content.cjs)
- [app/electron/message-media.cjs](app/electron/message-media.cjs) — local asset resolution and protocol response
- [app/electron/preload.cjs](app/electron/preload.cjs) — renderer-facing IPC bridge
- [app/electron/profile-isolation.cjs](app/electron/profile-isolation.cjs)
- [app/electron/store.cjs](app/electron/store.cjs) — workspace schema, import, edits and search
- [app/electron/text-emoji-names.json](app/electron/text-emoji-names.json)
- [app/electron/text-emoji-pack.cjs](app/electron/text-emoji-pack.cjs)
- [app/electron/wechat-adapter.cjs](app/electron/wechat-adapter.cjs) — history and incremental source import
- [app/electron/wechat-batch-reader.cjs](app/electron/wechat-batch-reader.cjs)
- [app/electron/wechat-discovery.cjs](app/electron/wechat-discovery.cjs)
- [app/electron/wechat-image.cjs](app/electron/wechat-image.cjs)
- [app/electron/wechat-incremental.cjs](app/electron/wechat-incremental.cjs)
- [app/electron/wechat-integrity.cjs](app/electron/wechat-integrity.cjs)
- [app/electron/wechat-keys.cjs](app/electron/wechat-keys.cjs)
- [app/electron/wechat-media-db.cjs](app/electron/wechat-media-db.cjs) — local resource lookup and media database cache
- [app/electron/wechat-profile-identity.cjs](app/electron/wechat-profile-identity.cjs)
- [app/electron/wechat-retry-context.cjs](app/electron/wechat-retry-context.cjs)
- [app/electron/wechat-snapshot.cjs](app/electron/wechat-snapshot.cjs)
- [app/electron/wechat-sync-gaps.cjs](app/electron/wechat-sync-gaps.cjs)
- [app/electron/wechat-sync-retry.cjs](app/electron/wechat-sync-retry.cjs)
- [app/electron/wechat-vault.cjs](app/electron/wechat-vault.cjs)
- [app/electron/worker.cjs](app/electron/worker.cjs) — writer and sync/AI dispatch

## Native reader

- [app/native/reader.c](app/native/reader.c) — native SQLCipher reader

## Build, smoke, and benchmark scripts

- [app/scripts/benchmark-archive-reliability.cjs](app/scripts/benchmark-archive-reliability.cjs)
- [app/scripts/benchmark-archive-views.cjs](app/scripts/benchmark-archive-views.cjs)
- [app/scripts/benchmark-auto-sync.cjs](app/scripts/benchmark-auto-sync.cjs)
- [app/scripts/benchmark-live-sync.cjs](app/scripts/benchmark-live-sync.cjs)
- [app/scripts/benchmark-sync-policy.cjs](app/scripts/benchmark-sync-policy.cjs)
- [app/scripts/benchmark-sync-reader.cjs](app/scripts/benchmark-sync-reader.cjs)
- [app/scripts/benchmark-sync-recovery.cjs](app/scripts/benchmark-sync-recovery.cjs)
- [app/scripts/build-info.cjs](app/scripts/build-info.cjs)
- [app/scripts/build-native.cjs](app/scripts/build-native.cjs)
- [app/scripts/profile-archive-stats.cjs](app/scripts/profile-archive-stats.cjs)
- [app/scripts/smoke-archive-views.cjs](app/scripts/smoke-archive-views.cjs)
- [app/scripts/smoke-auto-sync.cjs](app/scripts/smoke-auto-sync.cjs)
- [app/scripts/smoke-next-isolation.cjs](app/scripts/smoke-next-isolation.cjs)

## Tests and synthetic fixtures

- [app/tests/ai.test.cjs](app/tests/ai.test.cjs)
- [app/tests/archive-reliability.test.cjs](app/tests/archive-reliability.test.cjs)
- [app/tests/archive-views.test.cjs](app/tests/archive-views.test.cjs)
- [app/tests/auto-sync.test.cjs](app/tests/auto-sync.test.cjs)
- [app/tests/discovery.test.cjs](app/tests/discovery.test.cjs)
- [app/tests/emoji-pack.test.cjs](app/tests/emoji-pack.test.cjs)
- [app/tests/encrypted-fixture.c](app/tests/encrypted-fixture.c)
- [app/tests/fixtures/message-display.json](app/tests/fixtures/message-display.json) — synthetic message structures
- [app/tests/gif-timing.test.cjs](app/tests/gif-timing.test.cjs)
- [app/tests/live-ai.cjs](app/tests/live-ai.cjs)
- [app/tests/media-generation.test.cjs](app/tests/media-generation.test.cjs)
- [app/tests/media-resource.test.cjs](app/tests/media-resource.test.cjs)
- [app/tests/media-restore.test.cjs](app/tests/media-restore.test.cjs)
- [app/tests/message-content.test.cjs](app/tests/message-content.test.cjs)
- [app/tests/next-isolation.test.cjs](app/tests/next-isolation.test.cjs)
- [app/tests/review-workflow.test.cjs](app/tests/review-workflow.test.cjs)
- [app/tests/store.test.cjs](app/tests/store.test.cjs)
- [app/tests/sync-reliability.test.cjs](app/tests/sync-reliability.test.cjs)
- [app/tests/text-emoji.test.cjs](app/tests/text-emoji.test.cjs)
- [app/tests/video-location.test.cjs](app/tests/video-location.test.cjs)
- [app/tests/wal-writer.c](app/tests/wal-writer.c)
- [app/tests/wechat-profile-identity.test.cjs](app/tests/wechat-profile-identity.test.cjs)
- [app/tests/wechat.test.cjs](app/tests/wechat.test.cjs)

## Third-party notices

- [app/resources/licenses/SQLCipher.txt](app/resources/licenses/SQLCipher.txt)
- [app/resources/licenses/wechat-emoji-vocabulary.txt](app/resources/licenses/wechat-emoji-vocabulary.txt)

## Build configuration

- [app/index.html](app/index.html)
- [app/package-lock.json](app/package-lock.json)
- [app/package.json](app/package.json)
- [app/tsconfig.json](app/tsconfig.json)
- [app/vite.config.ts](app/vite.config.ts)

## Project documentation and source checks

- [.gitignore](.gitignore)
- [AGENTS.md](AGENTS.md)
- [AI_ANALYSIS_GUIDE.md](AI_ANALYSIS_GUIDE.md)
- [ARCHITECTURE.md](ARCHITECTURE.md)
- [CODE_MAP.md](CODE_MAP.md)
- [LICENSE](LICENSE)
- [README.md](README.md)
- [TESTING.md](TESTING.md)
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
- [docs/04-import-format.md](docs/04-import-format.md)
- [docs/39-text-emoji-local-pack.md](docs/39-text-emoji-local-pack.md)
- [scripts/repository-check.cjs](scripts/repository-check.cjs)
- [scripts/stage-review.cjs](scripts/stage-review.cjs)
