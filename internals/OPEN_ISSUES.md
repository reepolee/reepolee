# Reepolee Open Issues

Last reviewed: 2026-07-28.

This file replaces scattered planning notes. Code remains the source of truth; verify each item against source before changing behavior.

## Maintainability

1. **Split remaining oversized generator and admin modules.** The largest production files are `scripts/mcp/index.ts`, `generator/ddl_cache.ts`, `generator/crud/main.ts`, and `lib/middleware/rate_limit.ts`. `queue/index.ts` was already split into the `QueueStore` contract plus focused store files (`store_redis.ts`, `store_sql.ts`, `store_sql_dialect.ts`). Server lifecycle helpers and DDL-cache file storage are already extracted. Keep future splits focused on natural ownership boundaries, especially DDL cache parsing and MCP tool registration.
2. **Consider extracting route-system diagrams or examples from long prose docs.** `internals/ARCHITECTURE.md`, `internals/DEVELOPMENT_GUIDE.md`, and `internals/CONTEXT.md` are useful but dense. A short "generator lifecycle" page or diagram would make the regeneration boundaries easier to review.

## Code Quality

1. **Reduce test-file bulk where it blocks review.** Large test files such as `generator/ddl_cache.test.ts`, `generator/crud/schema_reader.test.ts`, `generator/generator.test.ts`, and `lib/template_engine.test.ts` cover important behavior. Split by scenario only if future changes make failures hard to localize.
2. **Container helper ownership moved out of this repo.** Existing local changes point container scripts to `../containers/`. Keep future Reepolee docs referencing that shared location instead of restoring deleted project-local scripts.
