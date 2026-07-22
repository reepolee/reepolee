# lib/ - Runtime Libraries

> **CODE IS THE SOURCE OF TRUTH.** This is a map of the runtime libraries. Read the module
> and its co-located `*.test.ts` before relying on any behaviour described here.
>
> Conventions: snake_case for everything, Bun native APIs only, keep files ~300 lines,
> break long method chains with temp variables. Run `reettier` after edits.

## Rendering & templates

| File / dir          | Role                                                                 |
| ------------------- | ------------------------------------------------------------------- |
| `render.ts`         | `render()` / `initialize_render()` - returns HTML `Response`        |
| `template.ts`       | `.ree` template engine entry                                        |
| `template/`         | Compiler internals: `compiler.ts`, `custom_elements.ts`, `include_handler.ts`, `include_resolver.ts` |
| `ree_icon.ts`       | Icon helper                                                          |

Full template + render API: [internals/REE_TEMPLATES.md](../internals/REE_TEMPLATES.md).

## Routing

| File                 | Role                                                          |
| -------------------- | ------------------------------------------------------------ |
| `route.ts`           | `normalize_prefix()`, `localized_url()`, `get_lang_from_request()`, `route_namespace_from_dir()` |
| `route_builder.ts`   | Defines the `RouteDefinition` type; `build_routes()` / `build_nav_routes()`; applies `mount_prefix()` for CRUD |
| `route_table.ts`     | Route table assembly                                         |
| `route_map.ts`       | Nav/route map, localized URL aliases, `slugify()`, `resolve_localized_path()` |
| `route_module.ts`    | Barrel-exported multi-file modules (auth, email)            |
| `route_state.ts`     | Route registration state                                    |
| `request_context.ts` | `create_ctx()` -> `RequestContext` (lang, user, toasts)     |
| `helpers.ts`         | Residual helpers only - path/prefix functions live in `route.ts` (see Path/Slash convention) |

## Middleware (`middleware/`)

Pipeline wiring is in `lib/route_state.ts` (`rebuild_routes_and_state`) via `wrap_all_routes()`:
`rate_limit_mw()` -> `set_lang()` -> `csrf_mw()`, where `csrf_mw()` is only appended when
`!is_agent` (CSRF excluded in `--agent` mode).

| File                  | Role                                                       |
| --------------------- | ---------------------------------------------------------- |
| `core.ts`             | `wrap_all_routes`, `mount_prefix`, `with_middleware`       |
| `rate_limit.ts`       | Sliding-window rate limiter (see [internals/RUNTIME.md](../internals/RUNTIME.md#rate-limiting)) |
| `set_lang.ts`         | Language resolution per request                            |
| `csrf.ts`             | Double-submit CSRF token validation                        |
| `cors.ts`, `timing.ts`, `require_module_mw.ts` | CORS, timing, module gating       |

## i18n / translations

`i18n.ts` - `TranslationRepository` (exported as `translations`): DB-first merge model,
root-namespace fallback, missing-key rendering (`mark_missing_from()`). Policy: see the
Translations section in the root [AGENTS.md](../AGENTS.md) and [internals/CONTEXT.md](../internals/CONTEXT.md).

## Database & SQL

| File                  | Role                                                       |
| --------------------- | ---------------------------------------------------------- |
| `resolve_db_type.ts`  | Auto-detect MySQL vs SQLite from `CONNECTION_STRING`       |
| `sql_dialect.ts`      | Dialect-specific SQL                                       |
| `table_filters.ts`    | List filtering                                             |
| `pagination.ts`       | Offset/cursor pagination helpers                           |
| `global_scopes.ts`    | `::session.*` scope resolution (see [internals/RUNTIME.md](../internals/RUNTIME.md#global-scopes-with-session-variables)) |

DB config lives in `config/db.ts`. Standalone-script connection-pool gotcha:
[internals/RUNTIME.md](../internals/RUNTIME.md#sql-connection-pool-gotcha).

## Storage, media, infra

| File / dir            | Role                                                       |
| --------------------- | ---------------------------------------------------------- |
| `s3/`                 | S3 client (`core.ts`) and proxy (`proxy.ts`)               |
| `local_storage.ts`    | Local file storage                                         |
| `image_processor/`    | libvips-backed crop/resize (`processing.ts`, `storage.ts`, `helpers.ts`) |
| `smtp.ts`             | Email sending                                              |
| `cache.ts`            | SQL/result cache                                           |
| `session.ts`, `cookies.ts` | Session and cookie handling                           |
| `logger.ts`           | File logging                                               |
| `livereload.ts`, `server_notify.ts`, `server_helpers.ts`, `bootstrap.ts` | Dev reload, server startup |
| `modules.ts`, `route_module.ts` | Module system                                    |
| `admin/`              | Admin-only helpers (`require_admin_auth.ts`, `rate_limits.ts`, `reload_translations.ts`) |
| `env.ts`, `object.ts`, `format.ts` | Small utilities (fail-loud env, object/format helpers) |
