# Memory Weave Public development

Use synthetic databases, media and accounts in tests. Do not open or migrate a real archive for development or validation. Do not commit exports, credentials, logs, screenshots, database copies, dependencies, or build output. Keep third-party provenance and license notices with the source they cover.

Run the tests and build documented in README. Check the staged source with `node scripts/repository-check.cjs index` and scan it for credentials and personal data before submitting changes. Review and publish only to the repository the owner has authorized.
