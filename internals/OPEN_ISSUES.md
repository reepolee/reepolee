# Reepolee Open Issues

Last reviewed: 2026-07-09.

This file replaces scattered planning notes. Code remains the source of truth; verify each item against source before changing behavior.

## Maintainability

1. **Split oversized generator and admin modules.** The largest production files are `scripts/mcp/index.ts`, `generator/ddl_cache.ts`, `routes/system/translations/handlers.ts`, `queue/index.ts`, `generator/crud/main.ts`, `routes/system/images/editor_server.ts`, `lib/server_helpers.ts`, and `lib/middleware/rate_limit.ts`. Most are understandable, but several sit well above the project guideline of roughly 300 lines. Good first splits are command registration vs execution in the MCP server, DDL cache storage vs parsing, and route handler orchestration vs form/query helpers in system routes.
2. **Review generated SQL lifecycle docs after the next generator pass.** Internal docs now describe `sql.ts` as regenerated output and recommend `sql.custom.ts` for long-lived custom queries. Keep the public website docs in sync whenever the generator preservation rules change.
3. **Consider extracting route-system diagrams or examples from long prose docs.** `internals/ARCHITECTURE.md`, `internals/DEVELOPMENT_GUIDE.md`, and `internals/CONTEXT.md` are useful but dense. A short "generator lifecycle" page or diagram would make the regeneration boundaries easier to review.

## Code Quality

1. **Reduce test-file bulk where it blocks review.** Large test files such as `generator/ddl_cache.test.ts`, `generator/crud/schema_reader.test.ts`, `generator/generator.test.ts`, and `lib/template_engine.test.ts` cover important behavior. Split by scenario only if future changes make failures hard to localize.
2. **Keep AI provider documentation tied to `generator/ai-provider.ts`.** The current order is `OLLAMA_URL`, then `GEMINI_API_KEY`, then `HF_TOKEN` only when `OPENROUTER_KEY` is unset, otherwise OpenRouter. Several docs had drifted here before this pass.
3. **Container helper ownership moved out of this repo.** Existing local changes point container scripts to `../containers/`. Keep future Reepolee docs referencing that shared location instead of restoring deleted project-local scripts.
