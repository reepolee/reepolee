# CONTEXT.md - Project Glossary

A project glossary - captured during design sessions to keep terminology precise and consistent.

## Rate Limiting

- **Rate limiting** - Middleware that restricts the number of requests a client can make within a time window, protecting the server from abuse and ensuring fair resource usage. Implementation in `lib/middleware/rate_limit.ts`, config in `config/rate_limit.ts`, tests in `lib/middleware/rate_limit.test.ts`.
- **`rate_limit_mw()`** - Middleware factory in `lib/middleware/rate_limit.ts`. Accepts an optional `RateLimitStore` for DI (testing). Registers as the first middleware in `wrap_all_routes()` in `lib/route_state.ts`. Production requires `RATE_LIMITING=true` and `TRUST_PROXY` set to `cloudflare` or `direct`; missing configuration exits with `process.exit(1)`. `REDIS_URL` is optional - the store falls back to SQL.
- **Sliding window counter** - Algorithm uses weighted averages of current and previous time-window request counts via `check_rate_limit()`. Formula: `estimate = prev_count × weight + current_count`, where `weight = elapsed_in_current_window / window_size`. O(1) memory per key, no boundary-burst problem.
- **Rate limit tiers** - 6 tiers defined in `config/rate_limit.ts`: `global` (300/60s), `login` (5/60s), `register` (3/60s), `password` (5/60s), `invite` (10/60s), `validation` (30/60s).
- **Scope resolution** (`resolve_scope()`) - Priority order: (1) validation endpoints ending in `/validate` get the validation tier, (2) exact path matches for `/login`, `/password`, `/invite`, (3) prefix match for `/register/*`, (4) everything else state-changing gets global.
- **Client identity** (`extract_identity()`) - Hybrid: session cookie `sid` for authenticated users, client IP for anonymous ones. The IP source depends on `TRUST_PROXY`: `cloudflare` reads `CF-Connecting-IP`, `direct` reads the socket peer address via `Server.requestIP()`. With neither set, anonymous callers collapse into a single `ip:untrusted-proxy` bucket - fail-closed, since trusting a spoofable header would be worse.
- **`TRUST_PROXY` modes** - `cloudflare` (Cloudflare-only origin, header trusted) or `direct` (no proxy, socket address trusted). Production requires one of the two; any other value exits with `process.exit(1)`. `direct` is only correct direct-to-origin - behind a proxy every request reports the proxy address and anonymous traffic shares one bucket.
- **`socket_ip()`** - Reads `globalThis.__reepolee_server` (installed by `lib/bootstrap.ts`) to call `requestIP()`. The server handle lives on globalThis rather than being threaded through the `Middleware` signature, which only carries `BunRequest`.
- **Rate limit headers** - Only on 429 responses: `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining: 0`, `X-RateLimit-Reset`. JSON (`application/json`) or inline HTML depending on Accept header. No headers on allowed requests.
- **Fail loud** - Rate limiting is disabled by default for local development. Production requires `RATE_LIMITING=true` and `TRUST_PROXY` set to `cloudflare` or `direct`; missing configuration exits with `process.exit(1)` and a red error message. No silent fallback to a pass-through limiter. `REDIS_URL` is not required: a Redis-free install is backed by SQL.
- **`RateLimitStore` interface** - Exported from `lib/middleware/rate_limit.ts` for DI. Defines `incr`, `expire`, `get` - a KV contract, not a backend. Implemented by both the Redis and SQL stores, and enables unit testing without mocking either.
- **Rate limit store resolution** - `resolve_rate_limit_store()` in `lib/middleware/rate_limit_store.ts` picks Redis when Redis is available (`REDIS_ENABLED=true` and a real `REDIS_URL`), SQL otherwise - the same config-driven pattern as the session store. The Redis client is constructed lazily; building it at import time would throw on an empty `REDIS_URL`.
- **`rate_limit_counters` table** - Backs the SQL store. Columns: `counter_key` (the `rl:...` key verbatim), `count`, `expires_at` (epoch-ms). `incr()` is a single atomic upsert with `RETURNING` - SQLite spells it `ON CONFLICT DO UPDATE`, MySQL/MariaDB `ON DUPLICATE KEY UPDATE`. An expired row resets to 1 rather than continuing the old tally.
- **429 response** - `rate_limited_response()` returns inline HTML for browsers or JSON for API clients. No template engine dependency - the middleware runs before `set_locale` and `csrf_mw`.

## Middleware

- **Middleware pipeline** - The ordered chain of functions that process every request before it reaches the route handler. In reepolee: `rate_limit_mw → set_locale → csrf_mw` (all via `wrap_all_routes()` in `lib/route_state.ts`).
- **`rate_limit_mw()`** - First in chain. Sliding window counter, guarded by `RATE_LIMITING` env var, 429 response with rate limit headers. Production fails loud without a valid `TRUST_PROXY` mode.
- **`set_locale()`** - Resolves the visitor's BCP 47 locale from `X-Locale`, the `locale` cookie, and the configured default, then redirects on locale switch.
- **`csrf_mw()`** - `Bun.CSRF`-signed tokens carried in the `csrf_token` cookie plus a `_csrf_token` field / `X-CSRF-Token` header; skips validation endpoints. `Bun.CSRF` has no `sessionId` parameter, so the per-identity binding comes from deriving the signing secret as `<CSRF_SECRET>:<identity>` - the `sid` session cookie when logged in, otherwise `csrf_sid`, an HttpOnly per-browser id issued alongside the token. Verification accepts either binding so a session id rotating at login does not 403 forms rendered moments earlier. Requires `CSRF_SECRET` (>= 32 chars) in production; dev/test use an ephemeral per-process secret. There is no fallback to the old unsigned cookie-equality tokens - that comparison is transplantable and would leave the binding inert. Shared with the fetch-handler-level upload endpoints via `require_valid_csrf()`.
- **`wrap_all_routes()`** - Applies middleware to all route handlers in the route table. Also adds trailing-slash redirect variants.
- **`mount_prefix()`** - Mounts a route table under a URL prefix with optional per-route middleware.
- **`publisher_signal_mw()`** - Per-route middleware attached in `lib/route_builder.ts` (not the global chain). After a route completes a successful mutation (POST/PUT/PATCH/DELETE resolving to 201/204/3xx), it fires a best-effort POST to `REEWEB_PUBLISHER_URL` so a paired Ree-web Publisher can re-render. Implementation in `lib/publisher_signal/index.ts`; 1s timeout, failures are logged and swallowed, never blocking the response. Does nothing unless `REEWEB_PUBLISHER_ENABLED=true` and `REEWEB_PUBLISHER_URL` is set - the URL can stay configured in `.env` while the publisher is not running.

## Redis

- **Redis client** - Use `import { redis } from "bun"` for the default client (reads from `REDIS_URL`, defaults to `redis://localhost:6379`). Use `import { RedisClient } from "bun"` for explicit connections. Never use `Bun.RedisClient` or `(Bun as any).RedisClient`.
- **`REDIS_URL`** - Environment variable for the Redis connection string. Used by the default `redis` client from `bun`. Only takes effect when `REDIS_ENABLED=true` (or `"on"`). Optional for rate limiting - when Redis is not available, the limiter uses the SQL store instead.
- **Rate limit keys** - Pattern: `rl:{scope}:{identity}:{window_start_epoch}`. Example: `rl:login:sid:abc-123:1717785600`.
- **Rate limit key TTL** - `2 × window_size` seconds (set via `expire()` on first INCR in each window). Redis auto-expires; the SQL store emulates this with `expires_at` (lazy expiry in `get()`) plus a 5-minute sweep started in `lib/bootstrap.ts`.
- **Sliding window algorithm** - Uses `redis.incr` (atomic increment) then `redis.get` (previous window count). No MGET/MULTI needed - INCR provides atomic first-increment semantics.

## SQL Cache

- **SQL Cache** - Redis-backed cache for `search_records` query results. Uses dependency-set invalidation: each cached search result is tracked as a member of a Redis SET per dependency table, so writes to a table invalidate all related cached searches.
- **`cache.search()`** - Wraps a `search_records` query: checks Redis cache first, caches result + tracks dependencies on cache miss. Falls back to query function on Redis error.
- **`cache.invalidate()`** - Deletes all cached results that depend on a given table by reading the `sql:deps:{table}` SET and DEL-ing all member keys plus the SET itself.
- **`CACHE_ENABLED`** - Env var to activate SQL caching. When `CACHE_ENABLED=true` but Redis is unavailable (`REDIS_ENABLED` not true/on or `REDIS_URL` missing), the process exits with an error (fail-loud, same as `RATE_LIMITING`). When not set or `false`, caching is a silent no-op.
- **Cache key format** - `sql:cache:{route}:{search}:{after}:{before}:{limit}:{order_by}:{scope}`. Simple concatenation, no hashing - human-readable and debuggable.
- **Cache TTL** - Default 300s (5 minutes). Configurable via `DEFAULT_TTL_S` in `$lib/cache.ts`.
- **Invalidation triggers** - Every write handler (create, update, delete, bulk delete) calls `cache.invalidate(TABLE_NAME)` after the DB mutation succeeds.
- **`TABLE_NAME`** - Exported constant in each generated `sql.ts` file, used as the dependency key for invalidation.
- **`VIEW_DEPENDENCIES`** - Exported array in each generated `sql.ts` listing all tables a search query depends on (the table itself + any joined FK tables). Used to register cache entries in multiple dependency sets.

## Queue

- **Queue store resolution** - `init_queue()` in `queue/index.ts` picks the backend: Redis when Redis is available (`REDIS_ENABLED=true` and a real `REDIS_URL`), the SQL database otherwise (same config-driven pattern as the rate limiter and session store). Without Redis the queue still works - no extra service required.
- **`QueueStore` interface** - `queue/store.ts`. Storage contract (insert, consume, complete, requeue, fail, queries, clearing, heartbeat, TTL sweep) implemented by `store_redis.ts` and `store_sql.ts`; `queue/index.ts` holds only policy (retry/dead-letter decisions, reaper timeout, worker concurrency).
- **Atomic claim** - A worker takes a job with one atomic operation: SQLite uses a single `UPDATE ... RETURNING` (writers serialize), MySQL `SELECT ... FOR UPDATE SKIP LOCKED` inside a transaction, Redis `BRPOP` plus marking the hash `running` and `SADD queue:running`. Exactly one worker receives a given job; there is no "popped but untracked" window, so a crash mid-processing leaves a `running` row the reaper finds.
- **Reaper (`reap_orphans()`)** - Called once at worker startup; re-queues jobs stuck in `running` whose `last_run_at` is older than the timeout (default 5 min). Bumps `attempts` so a handler that keeps crashing is dead-lettered instead of looping.
- **Delayed jobs** - `scheduled_for` > 0. On SQL the claim query filters on it, so the job becomes claimable when its timestamp arrives (no sweeper). Redis stores it in the delayed ZSET, which is written but not yet drained (pre-existing Redis limitation).
- **Worker heartbeat** - `set_worker_heartbeat()` / `is_worker_alive()` store the worker PID (`queue:worker:pid` Redis key / `queue_meta` table) and verify it with `kill -0`. Only meaningful when worker and server share a host.
- **Job TTL** - 24 h. Redis expires job hashes natively; the SQL store adds an `expires_at` column swept hourly by `cleanup_expired_jobs()` from `lib/bootstrap.ts` (skipped when Redis backs the queue).

## Auth surface (what the core expects from the auth plugin)

`resolve_session`, `require_auth`, `require_tag`, `create_user_session`, `destroy_session`, `refresh_session`, `Session_data` type, `User_public` / `User_record` types, auth routes (login, register, invite, password, profile), user SQL queries, avatar processing.

## Module

An optional subsystem that registers its own routes and can be enabled/disabled per-user via `modules_tags`. Examples: `auth`, `email`. Loaded at startup via `lib/modules.ts`. Available modules are determined by the `modules` database table.

## Prefix

A URL path segment that groups related routes under a common prefix (e.g. `/users`). Prefixes are detected automatically by `create_ctx()` and used to scope navigation, permissions, and route resolution. Available prefixes come from `get_available_prefixes()` in `lib/modules.ts`.

## Request context (`RequestContext`)

An immutable object created per-request via `create_ctx(req, meta_dir)` that carries `locale`, `ui_locale`, `preferred_locale`, `user`, `toasts`, `prefix`, `route_dir`, and `request_url`. Passed to `render()` as the `ctx` option. Central alternative to manual header/cookie parsing in each route handler.

## Route alias

A localized URL path variant generated from a canonical path using translation `route_name` keys. For example, `/login` may be aliased to `/prijava` in Slovenian. Aliases are expanded at startup via `expand_route_aliases_from_maps()` and resolved in O(1) via pre-built maps in `lib/route_map.ts`.

## Feature flag

A persisted toggle (stored in Redis) that controls gradual feature rollout. Created/set via `set_flag()` and checked via `is_enabled()` / `get_flags()`. Flags have an `enabled` boolean and a `rollout_pct` for percentage-based rollouts, plus per-user overrides and allowlists. Defined in `lib/feature_flags.ts` as an opt-in utility - it is not wired into bootstrap, and without Redis available (`REDIS_ENABLED=true` and `REDIS_URL`) every function no-ops (flags evaluate to `false`).

## Autocomplete component

`components/auto-complete.ree` - renders a searchable dropdown for foreign key fields with live search, keyboard navigation, and autoscroll. `<auto-complete>` custom element syntax.

## CRUD refresh (field-only)

A marker-based mechanism to regenerate only the field sections in `form.ree` and `index.ree` without overwriting user customizations. Uses HTML comment markers (`<!-- GEN:FIELDS:START -->` / `<!-- GEN:FIELDS:END -->`) to delimit managed sections. Available via `bun reeman refresh-crud <table> --mode fields` and as a reeman interactive sub-option. Requires an initial `--force` generation to inject markers.

## Managed section

Content between a pair of CRUD markers that is owned by the generator and replaced wholesale on refresh. Anything outside the markers is user-owned and preserved.

## Tags translation

Tags fields (columns ending in `_tags`) render checkboxes whose options come from the configured tags lookup table (`SELECT code AS tag_key, name AS tag_value`). The tag code (e.g. `admin`) is the stored value; `tag_value` is the displayed label. See [GENERATOR_INTERNALS.md](GENERATOR_INTERNALS.md#tags-translation) for the database model.

## Column comment-driven field type

The generator reads DB column comments at introspection time to determine field types. See [GENERATOR_INTERNALS.md](GENERATOR_INTERNALS.md#column-comment-driven-field-type) for the supported formats (plain word and JSON).

JSON comments take precedence over plain-word comments when both are present.

## CRUD-ignore table tag

A table comment containing the tag `crud-ignore` excludes that table from all reeman table listings (`get_available_tables()`), the bulk CRUD generator (`get_available_db_tables()`), and the `all` schema generation path. This lets you annotate internal or system tables (like `_prisma_migrations` or join tables) directly in the database without modifying code. The tag is case-insensitive (`crud-IGNORE` also works). SQLite does not support table comments, so this feature is MySQL-only.

## render_strategy

A per-route configuration in `schema/table.ts` that selects the page rendering mode for CRUD index handlers. Follows the same pattern as `pagination_strategy`.

```ts
const render_strategy: "stream" | "load" = "load";
```

- `"load"` (default) - current synchronous behavior: render the full page after all DB queries complete, return one `Response`.
- `"stream"` - declarative partial updates (DPU): render the page shell (layout, nav, controls) immediately as the first chunk of a `ReadableStream`, then stream record rows and pagination info as `<template for="...">` chunks after DB queries resolve.

The generator branches on this value at codegen time, selecting either the normal GET handler template or the streaming handler template. No runtime branching. Inspect `generator/templates/index/` and `generator/crud/` for the implementation.

## Missing translation rendering

When a translation key is not found or set in a locale file, the UI renders only the last segment of the dot-separated key path (e.g., `{new_equipment}` instead of `{user.equipment.actions.new_equipment}`). Fallback rendering happens in `lib/i18n.ts` via `mark_missing_from()`.

### How streaming works

1. Shell is rendered via normal `render("index", { data: { ...empty/loading state... } })` - produces the full HTML page with DPU markers
2. Shell is enqueued as the first `ReadableStream` chunk
3. After DB queries resolve, `<template for="records">` and `<template for="pagination">` chunks are streamed, each re-inserting `<?marker name="...">` for subsequent updates
4. `controller.close()` ends the stream

### DPU markers in templates

```html
<?start name="records">
<div class="p-4">Loading records...</div>
<?end>
```

### DPU polyfill

Vendored copy of [GoogleChromeLabs' HTML `<template>` setters polyfill](https://github.com/GoogleChromeLabs/html-setters-polyfill) at `static/dpu.min.js`. Downloaded by `bun get:dpu` (part of `bun get:pre`).

#### Where it's loaded

The polyfill script tag is placed in the `<head>` of `apps/main/layout.ree` (line 14), currently commented out:

```html
<!-- <script src="/dpu.min.js?v={= props.version }" defer></script> -->
```

It sits alongside the other vendored scripts (`helpers-client.js`, `validation-error.js`, `toasts-area.js`). The `defer` attribute ensures it executes after the HTML is parsed but before `DOMContentLoaded`. Uncomment when deploying DPU streaming to production.

Only `apps/main/layout.ree` (the single shared layout) contains the reference - no other layout exists or includes it.

#### Why it's needed

The DPU streaming mechanism sends page content as two types of chunks over a `ReadableStream`:

1. **Shell** - full HTML page (layout + nav + controls + empty DPU marker areas)
2. **Data chunks** - `<template for="records">` and `<template for="pagination">` elements containing the actual record rows and pagination controls, streamed after DB queries resolve

When the browser's HTML parser encounters these `<template for="...">` elements as they arrive via the stream, it must parse their inner HTML into the template's `content` DocumentFragment. Most modern browsers handle this correctly from the streaming parser. However, when **JavaScript** needs to create or modify `<template>` elements programmatically - for example, setting `innerHTML` on a `<template>` to replace its content - some browsers fail to parse the markup into the template's `content` fragment. The polyfill patches the `innerHTML` setter on `<template>` elements so that any declarative template markup injected via JavaScript correctly populates the `content` document fragment.

If client-side code manipulates `<template>` elements via `innerHTML`, the polyfill ensures correct behavior.

#### DPU data flow

```
Server (index_get_stream.ts)                    Browser
         │                                          │
         │  1. Render shell (layout + markers)      │
         │  via render_to_string("index", ...)       │
         │----------------------------------------->│  Display shell immediately
         │                                          │
         │  2. Wait for DB queries                   │
         │  (can be slow - 8s keepalive             │
         │   comments prevent idle timeout)          │
         │                                          │
         │  3. Stream pagination bar                 │
         │  <template for="pagination">...           │
         │  <?marker name="pagination">              │
         │----------------------------------------->│  Replace pagination area
         │                                          │
         │  4. Stream record rows                    │
         │  <template for="records">...              │
         │  <?marker name="records">                 │
         │----------------------------------------->│  Replace records area
         │                                          │
         │  5. Close stream                          │
         │----------------------------------------->│  Page fully loaded
```

The `<?marker name="...">` tag at the end of each chunk acts as a replaceable anchor - subsequent navigations (pagination, sort, search) send only the data chunks that replace the markers, keeping the shell intact.

#### Generator files

| Role                       | File                                                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Streaming handler (offset) | `generator/templates/index/index_get_stream.ts`                                                                                  |
| Streaming handler (cursor) | `generator/templates/index/index_get_stream_cursor.ts`                                                                           |
| Index rows partial         | `index_rows.ree` (generated per-route by `generator/crud/index_ree.ts`; rendered via `render_to_string` with `is_partial: true`) |

Both streaming handlers follow the same pattern: render shell → open `ReadableStream` → enqueue shell → set up keepalive → run DB query → enqueue pagination chunk → enqueue records chunk → close stream.

### Generator files affected

| File               | `"load"`                      | `"stream"`                                          |
| ------------------ | ----------------------------- | --------------------------------------------------- |
| `index.ree`        | No DPU markers                | Records + pagination wrapped in `<?start>`/`<?end>` |
| `index.ts` handler | `return render("index", ...)` | Returns `Response(ReadableStream)`                  |
| Template selection | `index_get.ts`                | `index_get_stream.ts`                               |

## Pagination strategies

Generated CRUD index views support two pagination strategies, selectable per-route via the `pagination_strategy` export in `schema/table.ts`.

### Cursor

Keyset pagination using the last-seen record's `id` and sort-field value as a cursor. URL params: `after`, `before`, `last`, `limit`, `order_by`, `query`, `scope`. SQL uses `WHERE (sort > val OR (sort = val AND id > id)) LIMIT N`. Center display shows `"{records.length} / {total}"`. No numbered page links - first/prev/next/last icon buttons. See [GENERATOR_INTERNALS.md](GENERATOR_INTERNALS.md#pagination-strategies) for cursor URL params and SQL strategies.

### Offset

Positional pagination using `LIMIT ? OFFSET ?`. URL params: `offset`, `limit`, `order_by`, `query`, `scope`. Center display shows `"{offset + 1}-{offset + limit} / {total}"` (range like "21-40 / 100"). Same first/prev/next/last icon buttons as Cursor. Supports global scopes. Nested children always use Offset.

### `pagination_strategy` schema export

```ts
export const pagination_strategy: "cursor" | "offset" = "offset";
```

Defaults to `"offset"` when absent. The generator branches on this value at codegen time to produce the appropriate SQL, URL param parsing, pagination URL building, and template rendering for each strategy. This follows the same pattern as `enable_delete`. To keep cursor-based pagination, set explicitly to `"cursor"`.

## Domain Types

Canonical column type taxonomy. These are the agreed conventions for all new tables and columns.

> **Code-defined constants:** These domain types are defined as typed constants in `config/domain_types/mysql.ts` and `config/domain_types/sqlite.ts` - that is the source of truth if this table and the code ever disagree. The tables below show the MySQL/MariaDB mapping; SQLite diverges for `pk_id`, `uuid_v7`, `binary`, `longtext`, `markdown`, `amount`, `currency_code`, `date`, `boolean`, `json_data`, and `country_code` (native SQLite affinities / ISO-8601 TEXT storage instead of MySQL-shaped SQL) - see `config/domain_types/sqlite.ts` for exact values.

### Basic SQL types

Generic type aliases (not business domains) used by Studio's "basic type" column picker and default table scaffolding. Reachable via exact column-name match, same as any other domain.

| Domain Type        | SQL             |
| ------------------- | --------------- |
| `integer`            | `INT`            |
| `unsigned_integer`   | `INT UNSIGNED`   |
| `bigint`             | `BIGINT`         |
| `real`               | `DOUBLE`         |
| `numeric`            | `DECIMAL(18,6)`  |
| `decimal`            | `DECIMAL(10, 2)` |
| `float`              | `FLOAT`          |
| `double`             | `DOUBLE`         |
| `varchar`            | `VARCHAR(255)`   |
| `char`               | `CHAR(1)`        |
| `binary`             | `BINARY(16)`     |
| `blob`               | `BLOB`           |
| `longtext`           | `LONGTEXT`       |
| `datetime`           | `DATETIME`       |
| `json`               | `JSON`           |

### PK & ID

| Domain Type   | SQL                            | Notes                                                                                                                                                                                                                                  |
| ------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pk_id`       | `INT UNSIGNED AUTO_INCREMENT`  | Canonical primary key. Migrate `INT` (signed) and `BIGINT UNSIGNED` to this.                                                                                                                                                           |
| `uuid_v7`     | `BINARY(16)`                   | Time-ordered UUID (RFC 9562). 48-bit ms timestamp + randomness. Generated via `Bun.randomUUIDv7()` (returns hex string) or `Bun.randomUUIDv7Bytes()` (returns `Uint8Array(16)` for DB storage). Native Bun API - no dependency needed. |
| `foreign_key` | `INT UNSIGNED`                 | FK columns; type matches the referenced PK.                                                                                                                                                                                             |

### Names

| Domain Type  | SQL            | Purpose                                          |
| ------------ | -------------- | ------------------------------------------------ |
| `first_name` | `VARCHAR(100)` | Person's given name                              |
| `last_name`  | `VARCHAR(100)` | Person's surname                                 |
| `full_name`  | `VARCHAR(255)` | Concatenated person or organization display name |
| `username`   | `VARCHAR(50)`  | Login handle                                     |

Name column widths are per-table (no universal convention). Use these when the semantic is known.

### Text & Descriptions

| Domain Type         | SQL              | Purpose                                                                        |
| -------------------- | ---------------- | ------------------------------------------------------------------------------ |
| `short_description`  | `VARCHAR(255)`   | Brief label, tagline, module description                                       |
| `long_description`   | `TEXT`           | Fuller comment, description, note                                              |
| `short_text`         | `VARCHAR(255)`   | Short free-form text value                                                     |
| `text`               | `TEXT`           | Unbounded long text (JSON blobs, translations, contract clauses, session data) |
| `markdown`           | `TEXT` (comment) | Rich text authored and stored as Markdown                                      |
| `slug`               | `VARCHAR(255)`   | URL-safe identifier derived from a title or name                               |
| `url`                | `VARCHAR(2048)`  | Full external or website link                                                  |

### Monetary, Percent & Quantities

| Domain Type  | SQL              | Config constant                                                                                                    |
| ------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| `amount`     | `DECIMAL(18,2)`  | `CURRENCY_FIELD` - all monetary values. Migrate `DECIMAL(10,2)` → this.                                            |
| `percentage` | `DECIMAL(7,4)`   | `PERCENT_FIELD` - all percentage/commission rates. Migrate `DECIMAL(4,2)`, `DECIMAL(5,2)`, `DECIMAL(10,3)` → this. |
| `quantity`   | `DECIMAL(12,3)`  | Order/inventory quantity, whole or fractional (e.g. `2 pcs`, `0.5 liter`). Unit lives in a separate column.        |

### Temporal

| Domain Type | SQL         | Suffix Convention                                                      |
| ----------- | ----------- | ---------------------------------------------------------------------- |
| `date`      | `DATE`      | `_on`, `_by` (e.g. `incorporated_on`, `payment_due_by`)                |
| `timestamp` | `TIMESTAMP` | `_at` (e.g. `created_at`, `verified_at`). Default `CURRENT_TIMESTAMP`. |
| `days`      | `INTEGER`   | Duration/count measured in days                                        |
| `months`    | `INTEGER`   | Duration/count measured in months                                      |
| `years`     | `INTEGER`   | Duration/count measured in years                                       |
| `hours`     | `INTEGER`   | Duration/count measured in hours                                       |
| `minutes`   | `INTEGER`   | Duration/count measured in minutes                                     |

Config constants: `DATE_SUFFIXES = ["_on", "_by"]`, `DATETIME_SUFFIXES = ["_at"]` (`config/db_structure.ts`). SQLite's canonical storage for `date` is `TEXT` (ISO-8601 `YYYY-MM-DD`) rather than a native `DATE` affinity - see `config/domain_types/sqlite.ts`.

### Boolean

| Domain Type | SQL          | Detection                                               |
| ----------- | ------------ | ------------------------------------------------------- |
| `boolean`   | `TINYINT(1)` | Prefix `is_`, `has_`, `can_` OR any `TINYINT(1)` column |

Config constant: `BOOLEAN_PREFIXES = ["is_", "has_", "can_"]`.

### Contact

| Domain Type    | SQL            | Purpose                              |
| -------------- | -------------- | ------------------------------------- |
| `email`        | `VARCHAR(255)` |                                        |
| `phone_number` | `VARCHAR(30)`  | E.164 international standard          |
| `locale`       | `VARCHAR(10)`  | BCP-47 language/region tag (`en-US`) |

### Code / Identifier

| Domain Type   | SQL           | Examples                                                    |
| ------------- | ------------- | ------------------------------------------------------------ |
| `code_short`  | `VARCHAR(5)`  | ISO country codes, currency codes                            |
| `code`        | `VARCHAR(20)` | Lookup codes (equipment, articles, languages)                |
| `code_long`   | `VARCHAR(64)` | Machine-generated tokens (scope keys, invitation codes)      |
| `status_enum` | `VARCHAR(30)` | State-machine status names                                   |
| `sku`         | `VARCHAR(64)` | Product/inventory stock-keeping unit                         |
| `gtin`        | `VARCHAR(14)` | Global Trade Item Number - EAN-8/13, UPC-A, GTIN-14 barcode |
| `tax_id`      | `VARCHAR(30)` | VAT/company tax identifier (format varies by country)        |

Widths are per-domain, not forced - these are recommended buckets.

### Address

| Domain Type      | SQL            | Notes                       |
| ----------------- | -------------- | ----------------------------- |
| `street_line_1`   | `VARCHAR(150)` |                                |
| `street_line_2`   | `VARCHAR(100)` |                                |
| `city`            | `VARCHAR(100)` |                                |
| `state_province`  | `VARCHAR(100)` | Regional subdivision          |
| `postal_code`     | `VARCHAR(20)`  |                                |
| `country_code`    | `CHAR(3)`      | ISO 3166-1 alpha-2 / alpha-3  |
| `country_name`    | `VARCHAR(100)` | Full display country name     |

### Security & System

| Domain Type     | SQL            | Purpose                                |
| ---------------- | -------------- | ----------------------------------------- |
| `password_hash`  | `VARCHAR(255)` | Argon2id / PHC formatted password hash    |
| `ip_address`     | `VARCHAR(45)`  | IPv4/IPv6 address stored as text          |
| `json_data`      | `JSON`         | Serialized structured application data    |

### Media

| Domain Type  | SQL            | Suffix Convention                              |
| ------------ | -------------- | ------------------------------------------------ |
| `image_path` | `VARCHAR(512)` | `_image` (e.g. `portrait_image`, `logo_image`) |
| `file_path`  | `VARCHAR(512)` | `_file` (e.g. `contract_file`, `invoice_file`) |

`image_path` stores a browsable path (e.g. `/images/teams/members/xyz.webp`), not the binary itself - see `lib/image_processor/`, `lib/s3.ts`. Rendered as `<image-upload>` in forms and `{~ image_thumbnail(...) }` (100x100) in grids - see [REE_TEMPLATES.md](REE_TEMPLATES.md#image-upload-component). Config constant: `IMAGE_SUFFIXES = ["_image"]`.

`file_path` stores a browsable path to an uploaded document (e.g. `/files/contracts/xyz.pdf`), not the binary - see `lib/file_processor/`, `lib/s3.ts`. Rendered as `<file-upload>` in forms (drag-and-drop dropzone, async POST to `/files/save`), width `COL_WIDTH_FILE` in grids. Config constant: `FILE_SUFFIXES = ["_file"]`. The `/system/files` route provides a full CRUD file library over the `files` table; storage keys are namespaced by folder and the `files` bucket is served via `register_s3_mount({ url_prefix: "/files/", … })` (mounted in `lib/bootstrap.ts`, bucket from `S3_FILE_BUCKET`, default `files`).

## Generated columns (VIRTUAL / STORED)

MySQL generated columns (`VIRTUAL GENERATED` / `STORED GENERATED`) are detected during schema introspection via `EXTRA` in `INFORMATION_SCHEMA.COLUMNS`. SQLite detects them via `PRAGMA table_xinfo().hidden > 0`. Generated columns are excluded from write fields because they cannot be directly inserted or updated. The required `display` and optional `option_display` columns remain in read fields; other generated table columns are omitted from generated CRUD metadata.

## Fulltext search

When a table has a `search_text` column, the CRUD generator produces fulltext search queries instead of `LIKE '%term%'`. This applies to both the WHERE clause and the COUNT query on search. See [GENERATOR_INTERNALS.md](GENERATOR_INTERNALS.md#fulltext-search) for the SQL patterns. Requires a MySQL FULLTEXT index.

## Sort options from indexed columns

The CRUD generator produces sort options via `generate_sort_options()` in `generator/crud/helpers.ts` (not a schema export). It always provides `ASC`/`DESC` entries for `id` and the canonical `display` field, then adds indexed columns. The indexed column names are stored as `indexed_columns` in `table.generated.ts` at introspection time and are also exported from `table.ts` for user editing. FK `_id` sorting resolves to the view's corresponding `<stem>_display` column when present.

## `IGNORE_ORDER_FIELDS`

Global constant in `config/db_structure.ts` listing columns excluded from sort options. Default: `["option_display", "search_text", "hashed_password", "previous_hashed_password"]`. Mirrors `IGNORE_INDEX_FIELDS` but for the sort dropdown.

## Nested CRUD (master-detail)

A parent-child relationship where a child table's records are scoped to a single parent record and managed via nested URLs. The parent ID appears in the URL path (e.g `/orders/:order_id/items`). The parent FK is auto-detected from DB foreign key constraints at schema generation time, overridable in `schema/table.ts` via a `parent` export.

## Parent context

When viewing or editing child records, the parent record's identity is loaded and displayed for context. On the parent's edit form, children appear as a simple list (no pagination/search/sort) rendered inline below the parent form fields. The child's `new` and `edit` forms pre-fill and hide the parent FK field.

## Inline child list

A simple list of child records rendered on the parent's edit form. Shows all children ordered by primary key without pagination, search, or sort. Each row has edit and delete actions. Rendered server-side by the parent's edit handler. No dedicated child index page exists - the only way to see children is on the parent's edit form.

## Nested route (single level)

The child table generates absolute URL paths that include the parent's route param segment (e.g `/orders/:order_id/items/new`, `/orders/:order_id/items/:item_id/edit`). Route registration in `routes.ts` is flat - child CRUD routes spread directly into the routes object without `mount_prefix`. Nesting is limited to single level: parent → child.

## Child CRUD route map

A nested child generates the following route table (no GET index handler, no dedicated index page, no bulk-delete):

```ts
export const orders_items_crud = {
	"/orders/:order_id/items": { POST: post_orders_items_index },
	"/orders/:order_id/items/:item_id/edit-data": get_orders_items_edit,
	"/orders/:order_id/items/:item_id/edit": { POST: post_orders_items_edit },
	"/orders/items/validate": { POST: post_orders_items_validate },
	"/orders/:order_id/items/validate": { POST: post_orders_items_validate },
};
```

- `POST /orders/:order_id/items` - create new child (called via AJAX from parent edit page)
- `GET /orders/:order_id/items/:item_id/edit-data` - get child record data as JSON (for populating edit dialog)
- `POST /orders/:order_id/items/:item_id/edit` - update/delete (via `_action=delete`)
- `POST /orders/items/validate` - validate child data (standalone, table-scoped)
- `POST /orders/:order_id/items/validate` - validate child data (scoped)
- No dedicated child index page, no `bulk-delete` route

## Parent export (`schema/table.ts`)

The child's schema exports a `parent` object describing the relationship:

```ts
export const parent = {
	table: "orders", // Parent table name
	fk_column: "order_id", // FK column name in THIS table
	route_param: "order_id", // URL param name (matches FK column)
};
```

Discovered automatically from DB foreign key constraints at introspection time when `--parent <table>` is passed. Overridable by editing the generated file.

## Child generator parent-file integration

When `--parent orders` is specified, the child generator (`resource.ts`/`crud.ts`) also modifies the parent's files:

- **Parent `sql.ts`**: Adds a `get_{children}_by_{parent_fk}(parent_id)` query function.
- **Parent `index.ts`**: Edit handler loads child records via the new query function, passes them to the template as `child_records` and child field definitions as `child_fields`.
- **Parent `form.ree`**: Appends a managed marker section (`<!-- GEN:CHILDREN:START -->`) with the inline child list table.

## Child SQL scoping

All child SQL queries accept a parent ID parameter and include `WHERE parent_fk = ?`. Individual record lookups (`get_record_by_id`) also verify the parent FK matches for security - prevents accessing children scoped to a different parent.

## Child form FK field handling

The parent FK field in the child's `form.ree` is rendered as `<input type="hidden">` inside a `<field-wrapper>` element. The value is pre-filled from the URL route param (new) or the database record (edit). The field is excluded from validation since it's set programmatically.

## Return URL flow

Child new/edit forms auto-set `_return_url` to the parent's edit page URL. On successful create/update/delete, the user is redirected back to the parent edit page (`/orders/:order_id/edit`). The `base_path()` and `entity_path()` helper functions accept the parent ID as a parameter.

## Inline child list template

The parent's edit form renders a simple HTML table below the form fields showing all child records. Each row has:

- Columns corresponding to the child's display fields
- An "Edit" link → `/orders/:parent_id/items/:child_id/edit`
- A `<form>` with a "Delete" button → POSTs to `/orders/:parent_id/items/:child_id/edit` with `_action=delete`

## Global scopes with session variables

Global scopes can reference the currently logged-in user's session data at query time using `::session.*` variable tokens in the `where_clause` column.

### Syntax

Tokens use `::` prefix, variable path runs to the next space:

```
author_id = ::session.user.id
created_by = ::session.user.email
```

### Supported variables

| Path                          | Session field  | Type   |
| ----------------------------- | -------------- | ------ |
| `::session.user.id`           | `user_id`      | number |
| `::session.user.email`        | `email`        | string |
| `::session.user.name`         | `name`         | string |
| `::session.user.nickname`     | `nickname`     | string |
| `::session.user.username`     | `username`     | string |
| `::session.user.modules_tags` | `modules_tags` | string |

### Which scope is active (`resolve_scope_key()`)

Exported from `lib/global_scopes.ts`. Picks the `scope_key` an index request should filter by, precedence URL param `?scope=` > `scope_<table>` cookie > the table's default scope (`global_scopes.find(s => s.is_default)`):

```ts
export function resolve_scope_key(global_scopes: ScopeDef[], url_scope: string, cookie_scope: string | null): string
```

Both the URL param and the cookie are user-controlled, so `resolve_scope_key()` validates each against the `global_scopes` list already loaded for that table/route and only accepts a known `scope_key` - an unrecognized value is skipped rather than passed through. This matters because `get_scope_clause()` returns an empty (unfiltered) WHERE clause when a `scope_key` matches no row, so accepting an arbitrary `?scope=` value here would let a request silently drop the admin-configured filter instead of falling back to the table's default. `get_global_scopes()` also forces `is_default = true` when a table has exactly one scope - a single scope is an admin-imposed restriction, not a menu choice, so it always applies regardless of the stored flag.

Called from every generated index route (`generator/templates/index/*.ts`) and from the hand-written routes that use scopes (`apps/reeman/users/index.ts`, `apps/reeman/modules/handlers.ts`, `apps/reeman/global_scopes/index.ts`).

### Resolution (`get_scope_clause()`)

`get_scope_clause(table_name, scope_key, ctx?, route_name?, module_code?)` - optional `RequestContext`, `route_name`, and `module_code` parameters. When present and the `where_clause` contains `::session.*` tokens:

1. Parse `::session.(path)` tokens via regex
2. Look up the session field from `ctx.user`
3. Auto-escape: numbers as bare literals, strings as single-quoted with `''` escaping
4. Fall through to `1=0` (fail-loud) if user is not authenticated but `::session.*` tokens are present
5. Log a warning on unresolvable tokens

`::session.*` variables are AND-combined with other filters in generated CRUD SQL, just like regular scope clauses.

### Expression values (`::session.user.modules_tags`)

The `modules_tags` field stores comma-separated module codes (e.g. `"admin,editor"`). A typical scope clause using it for MySQL:

```
FIND_IN_SET('admin', ::session.user.modules_tags)
```

### UI picker

The global scopes edit form includes a dropdown of clickable variable chips below the `where_clause` field. Clicking a chip appends the `::session.*` token at the cursor position in the textarea.

### `username` in session

To support `::session.user.username`, the `User_public` and `Session_data` types carry the `username` field from the `users` table. Session creation in `create_user_session()` includes it.

### Resolution function (`resolve_session_variables()`)

Exported from `lib/global_scopes.ts`. Pure function (no DB access) that powers both runtime scope resolution and the admin preview feature.

```ts
export function resolve_session_variables(clause: string, ctx?: RequestContext): string;
```

**Logic:**

1. Fast-path: if clause doesn't contain `::`, return as-is
2. Early-exit: if `::` present but no `::session.` prefix, return as-is
3. Fail-loud: if `::session.*` tokens found but no `ctx` or no `ctx.user`, return `1=0` with warning
4. Regex replace: `/::(session\.\S+)/g` - captures the full `session.user.<field>` path
5. Lookup in `SESSION_VARIABLES` registry - unknown paths → `NULL` with warning
6. SQL escape: numbers as bare literals, strings as `'single-quoted with '' escaping'`, null → `NULL`

**Variable registry** (`SESSION_VARIABLES`):

| Key                         | Resolver                         |
| --------------------------- | --------------------------------- |
| `session.user.id`           | `ctx.user?.id ?? null`           |
| `session.user.email`        | `ctx.user?.email ?? null`        |
| `session.user.name`         | `ctx.user?.name ?? null`         |
| `session.user.nickname`     | `ctx.user?.nickname ?? null`     |
| `session.user.username`     | `ctx.user?.username ?? null`     |
| `session.user.modules_tags` | `ctx.user?.modules_tags ?? null` |

`SESSION_VARIABLE_PATHS` is an exported `string[]` of all registry keys, used by the UI picker and form templates.

### Preview endpoint

`POST /system/global_scopes/test-scope` - lets admins test a WHERE clause against a selected user.

**Request:** `{ where_clause: string, test_user_id: number }`
**Response:** `{ resolved_clause: string }`

The handler loads the test user from DB, builds a minimal `RequestContext` with that user's fields, calls `resolve_session_variables()`, and returns the resolved SQL.

**UI location:** Collapsible "Preview resolved SQL" section below the WHERE clause field on the global scopes new/edit forms. Includes a user dropdown (from `get_users_select_options()`), a "Preview" button, and a `<pre>` block for the resolved clause output.

### Unit tests

`lib/global_scopes.test.ts` - 21 tests covering:

- **Passthrough** (3): no `::`, non-session `::`, CSS-like `::hover`
- **Fail-loud** (2): missing ctx, null user → `1=0`
- **Number resolution** (2): single `id`, compound expression
- **String resolution** (3): email, Unicode name, username
- **modules_tags** (1): comma-separated quoted string
- **SQL escaping** (2): single quote, multi-quote injection
- **Unknown/null** (3): unknown path, null field, null modules_tags
- **Mixed SQL** (2): with literals, complex WHERE
- **Export check** (1): `SESSION_VARIABLE_PATHS` has all 6 keys
- **Edge cases** (2): clause ending with `::session`, multiple `::session` tokens in one clause

Uses `mock.module("$config/db", ...)` to avoid real DB connection. Follows patterns from `lib/helpers.test.ts` and `lib/cache.test.ts`.

### Delimiter convention

`::session.*` variables are delimited by **space** - the `\S+` regex captures everything until the next whitespace. This means closing parentheses or commas immediately after a token are captured as part of the path. To use inside `IN (...)` or `FIND_IN_SET()`, add a space before the delimiter:

```
FIND_IN_SET('admin', ::session.user.modules_tags )   ← space before )
author_id IN (::session.user.id , ::session.user.id ) ← spaces before ,
```

### Exported for testing

- `resolve_session_variables(clause, ctx?)` - token resolution (pure function)
- `SESSION_VARIABLE_PATHS` - registry keys array

The `SESSION_VARIABLES` map is private (module-scoped const). New session variables are added by extending the registry, no other changes needed.

## ReeTag

- **ReeTag** - The component include form in `.ree` templates: a hyphenated HTML-like custom element (e.g. `<app-banner type="red">content</app-banner>`). The template pre-processor (`lib/template/custom_elements.ts`) converts it internally to `{#include("<resolved include path>", {children, attributes})}`. The include path comes from the startup component index (`precompile_templates()`): `components/<tag>.ree` → `$components/<tag>` wins; otherwise a same-named file anywhere in the routes tree (`apps/main/examples/kitchen_sink/star-rating.ree` → `examples/kitchen_sink/star-rating`) or in a mounted route-module root (`<module-code>/<name>`). A tag with no matching file anywhere is passed through as literal HTML (native web components like `<date-input>`). Dev self-heals: a tag missing from the index triggers one filesystem search (cached afterwards, negatives too). For cases where the props object itself must be computed (e.g. spreading additional fields), use `{#include("$components/name", computedProps)}` directly. Template expressions `{= expr }` / `{~ expr }` / `{_ path }` / `{- path }` inside ReeTag attribute values ARE compiled at render time. `{_ }`/`{- }` in an attribute resolve against `props.translations` via `parse_attributes()` in `custom_elements.ts` - a separate code path from the main tokenizer's `emit_translation_lookup()`, so the safe-walk + `{last_segment}`-on-miss logic is duplicated there rather than shared.
- **Attribute spread shorthand (`...expr`)** - `<tag ...rest>` / `<tag ...props.translations.errors>` expands to the referenced object's key/value pairs as HTML attributes (`{~ key_values(expr) }`), evaluated at render time. Three regex sites in `custom_elements.ts` implement it: `parse_attributes()` (ReeTag components), the plain-element pass-through branch inside `preprocess_template()` (custom elements with no matching `components/*.ree` file, e.g. `<date-input>`), and `expand_spread_shorthand()` (ordinary hyphen-less HTML tags). All three accept a dotted member path (`ident(.ident)*`), not just a bare identifier - arbitrary expressions (calls, indexing, ternaries) aren't supported; assign to a local first if needed.

## Content localization (locale-suffixed tables)

UI strings live in the `translations` table (see below). **Record content** -
a framework's name, a room's description - is a separate axis and uses
locale-suffixed tables. Design record: `.agents/PLAN_locale_suffixed_tables.md`.

- **Base table = default locale.** `frameworks` holds `en-us` content when
  `en-us` is `default_locale`. There is no `frameworks_en_us`.
- **One clone per non-default locale.** `frameworks_sl_si` is a structural
  clone: same columns, same types, FK targets rewritten to the locale-matched
  table when that target is itself localized (`developers_sl_si`) and left
  pointing at the shared base table when it is not (`languages`).
- **A single-locale app is unaffected.** No suffix, no clone, no flag - the
  generated output is identical to a non-localized app.
- **Opt in per column** with `localized: true` in `schema/table.ts`. That flag
  is the only generation-time localization decision; *which* locales exist is
  config, resolved per request.

### Reads

The physical table is resolved once per request from `ctx.locale` via
`locale_table()` (`lib/locale_tables.ts`), which returns the base table for the
default locale **and for any unconfigured locale** - `ctx.locale` comes from a
header or cookie, so it must never be able to name a table that does not exist.
Views follow the same rule: `v_frameworks` vs `v_frameworks_sl_si`.

### Writes (fan-out)

`lib/locale_write.ts`. A write touches every physical table:

- **create** - insert into the base, then clone into each locale table with the
  base row's id forced, so every locale of a record shares one id
- **update** - the edited locale's table takes every column; every other table
  takes only the **non-localized** columns, so editing Slovenian cannot
  overwrite the German translation while shared data (FKs, dates, flags) stays
  identical everywhere
- **delete** - clones first, then the base

Because a write touches every clone's shared columns, `invalidate_all_locales()`
invalidates **every** locale's cache dependency set, not just the edited one.
Generated write handlers no longer call `cache.invalidate()` themselves - the
sql layer owns it.

### Copy provenance

Two sidecar columns per localized field, on locale tables only:
`<field>_src` (source locale) and `<field>_hash` (hash of the source value at
copy time). A cloned value is stored and rendered as a **normal value** - there
is no "inheriting" state. Editing a value by hand clears its provenance, since
an edited value is no longer a copy. `stale_copy_notices()`
(`lib/localized_copy.ts`) compares the stored hash against the source's current
value to drive the "the original changed" notice.

### Keeping clones in sync

`bun reeman sync-locale-tables [table|all] [--dry-run]` creates, alters, and
drops clone tables so they match their base table plus the configured locales.
Idempotent. It runs automatically after `crud`/`refresh-crud` for localized
tables, and after `add-locale`/`remove-locale`.

A consistency check runs inside `load_ddl_cache()` **before** the snapshot is
published, so drift can never be captured as truth and inherited by every
generation in the session. reeman warns and names the repair command; callers
can opt into failing instead via `set_locale_drift_mode("fail")`
(`generator/ddl_cache.ts`).

## Translations (i18n)

- **Co-located locale files** - The source of truth for UI translations. A namespace maps to its route directory and each locale is a `{locale}.json` file. Root fallback strings live in repository-root locale files.
- **File-only runtime model** - At startup, translations are loaded from `apps/main/`, `apps/reeman/`, and repository-root locale files. UI strings do not depend on the database.
- **`sync-translations`** - Scans namespace files, translates missing keys via the configured AI provider, and writes results back to the files.
- **Translation bundles** - `export-translation-bundle` combines every current `en-us.json` into one versioned transport file whose top-level file map uses repository-relative source paths. An external service translates only final string leaves. `import-translation-bundle` accepts complete or partial file/key sets, normalizes source or target-locale path endings, rejects unknown paths/keys and invalid leaves/placeholders, and merges accepted leaves into one current `locales-archive/{locale}.json` bundle without deleting omitted translations. `--install` restores the locale to co-located live files. Bundles are transport and inactive-locale archive artifacts; co-located locale files remain the runtime source of truth.
- **`extract_untranslated()` (`lib/translation_merge.ts`)** - Flags a key as needing AI translation when the locale's value is missing, `::missing::`-prefixed, or *identical* to the English value (heuristic for "never actually translated"). **`config/excluded_translations.ts`** lists key-path prefixes exempt from the identical-value check - for keys whose value is intentionally the same across locales (e.g. `ui.language_name.*`, cross-language name data populated by `add-locale`'s own AI calls; `ui.seconds`, `ui.ttl`, short unit/abbreviation strings). Without the exclusion these keys get re-sent to the AI on every sync run even though nothing is actually untranslated.
- **`insert-translations`** - Scans `.ree` templates for referenced keys missing from locale files and prepares file-backed additions for review.
- **`add_translations`** - Adds explicitly supplied locale, namespace, key-path, and translation values to the appropriate files, skipping existing values.
- **Namespace** - Dot-separated path derived from the route directory (e.g. `system.auth.login`).
- **Key path** - The lookup key within a namespace (e.g. `actions.save`). Templates access translations as `{_ actions.save }`.
- **`route_name` key** - Reserved translation key. Its value drives URL localization. `route_name: "drzave"` for namespace `countries` makes `/countries` available as `/drzave` in the Slovenian locale. Never inherited from another locale - a missing value means "use canonical segment."
- **`root` namespace** - Repository-root locale files. They provide fallback keys when the current route namespace does not define a value.
- **Translation reload endpoint** - `POST /__reload-translations` calls `reload_all_translations()` and `reload_route_maps()` on the running server so nav labels and in-memory maps update without a restart. Secured by `RELOAD_SECRET` env var (`X-Reload-Secret` header).
- **Prune tool** - Scans `.ree` templates, maps each reference to its file namespace, and reports unused namespace/key-path pairs. Root fallback and system-managed keys are protected.
- **MCP tools** - `list_translations` and `get_translations` inspect translation state; `sync_translations`, `insert_translations`, and `add_translations` perform translation operations when `MCP_ENABLE_MUTATIONS=true`; `reload_translations` refreshes in-memory state.
- **Limitations** - Dynamic references (`{= labels[key] }`) cannot be detected statically by the prune tool. Tag translations (`modules_tags.*`) are looked up by code, not by template expressions.
- **Missing-translation marker** - `{key}` (curly braces, last dot-segment only, e.g. `{cancel}`, `{new_equipment}`). The one visual convention for "this translation is not resolved," regardless of cause. Two producers: (1) `mark_missing_from()` in `lib/i18n.ts` - runs at load time, marks a missing value in a non-default locale when the default locale has the key; (2) the `{_ path }` template tag (see below) - runs at render time, catches a key absent from the merged translations object in every locale. `nav_label()` in `lib/template_helpers.ts` also emits `{last_segment}` for missing nav entries - all three producers converged on the one marker format.
- **`ctx.translations`** - Populated inside `create_ctx()`, one resolution per request, using alias-resolved `ctx.ui_locale` and `ctx.route_dir`. Namespace and root fallback merge in `create_ctx()` / `RequestContext`. Translation files are loaded into memory once at startup and refreshed by `POST /__reload-translations` after file edits; in dev, `lib/watcher.ts` watches `{locale}.json` files and reloads them (plus route maps) automatically.
- **Two whole-app translation trees: `nav`, `nav_prefix_title`** - These keys live in namespace files but merge under `routes.nav.<namespace>` and `routes.nav_prefix_title.<namespace>`. `nav_label()` reads the merged whole-app dictionaries.
- **`{_ path }` / `{- path }` / `{@ path }` tags** - Dedicated template tags for translation lookups, distinct from `{= }`/`{~ }`. `{_ }` HTML-escapes (the common case - translation strings are plain text); `{- }` does not (mirrors the `{~ }` unescaped convention, for the rare translation value that legitimately contains markup); `{@ }` renders the resolved value through markdown to HTML via `Bun.markdown.html()` (for a translation value authored as markdown source - headings, lists, `**bold**`, links). `path` is a restricted dotted property path only (e.g. `labels.text_input`) - no arbitrary JS, no function calls, no computed keys. Always resolves against `props.translations` (populated by `render()` from `ctx.translations` - see above) via a safe compile-time property walk - never eval-and-catch. On a missing key, or when `props.translations` is absent entirely (legitimate during active development - see "Translations are mandatory infrastructure" below), renders `{last_segment}` instead of throwing or silently rendering empty - same marker convention as `mark_missing_from()` (`{@ }` wraps that marker in a `<p>` per markdown rules). `{= }`/`{~ }` remain technically able to reach `props.translations` directly but this is discouraged by convention (documentation only, no lint enforcement) since it bypasses the missing-key marker. Fetch-only - does not interpolate placeholders like `{count}` into the resolved string; that stays the job of `plural()` / `format_bulk_delete_message()`, called against `ctx.translations.messages` in the route handler, same as today. Variable interpolation inside `{_ }`/`{- }`/`{@ }` is a deferred, separate future tag - not designed yet. Tokenizer: adds `_`, `-`, and `@` to the compiler's prefix character class (`lib/template/compiler.ts`, `[~=#:/_@-]`) - none of these characters collides with any existing `.ree` syntax (raw-JS `{{ }}` blocks, ReeTag hyphenated custom elements, HTML comments, or `{&:hover{...}}` CSS-nesting braces).
- **Reeweb engine copy** - Reeweb runs a copy of this `.ree` template engine. Both products resolve UI translations from JSON-backed translation objects and use the same missing-key markers.
- **Design rationale** - `{_ }` and `{- }` keep translation lookup distinct from direct value rendering (`{= }` and `{~ }`). Prefix matching is intentionally avoided because it cannot distinguish a missing key from a nested value without changing normal render semantics.
- **Translations are mandatory infrastructure** - Every app uses co-located locale files for UI strings, including single-locale deployments. Multi-locale readiness remains the default posture from day one.

## Test Database

- **`db:clone-test`** - Script at `scripts/clone_db.ts`. Clones the development DB (from `DEV_CONNECTION_STRING`) to the test DB (from `TEST_CONNECTION_STRING`). Supports `--yes` (skip confirmation), `--dry-run`, and `--no-data` (DDL only, no row data). Handles MySQL through Bun SQL connections to the hosts in the connection strings and SQLite locally. MySQL tables, data, views, and triggers are copied separately. The target database is automatically recreated. MySQL snapshot/restore modes still use `${CONTAINER_ENGINE:-podman} exec mariadb`.
- **`TEST_CONNECTION_STRING`** - Environment variable for the test database connection. Used by `db:clone-test` and integration test files that need a real DB connection. The database name must contain "test" - `config/test_db.ts` enforces this safety guard and calls `process.exit(1)` if violated.
- **Safety guard** (`config/test_db.ts`) - `extract_db_name()` parses the DB name from MySQL/SQLite connection strings. `enforce_test_db()` exits with an error if the parsed name doesn't contain "test". `get_test_db()` combines both: reads `TEST_CONNECTION_STRING` via `require_env()`, validates it, and returns a new `SQL` connection.
- **Integration test pattern** - Use `get_test_db_connection()` from `test_helpers.ts` to connect to the cloned DB, then mock `$config/db` with `make_test_db_mock()`. Isolate with `START TRANSACTION` / `ROLLBACK` around each test.

## Dev SQL runner

- **`bun run sql`** - `scripts/run_sql_dev.ts`. Runs SQL from a file path, an inline SQL argument (`bun sql "select * from modules"`), or stdin (grep-style - no input means stdin) against the app's DB via the `lib/sql_runner` runner and prints per-statement `{ meta, records }` JSON. Statements are split before execution because `unsafe()` only returns the first result set of a multi-statement string. Read-only by default: each statement must be a single SELECT and records are capped (default 100, max 1000 via `--limit=N`); `--allow-changes` permits writes/DDL. Exits non-zero when any statement fails or the input has no statements. Same engine as the MCP `run_sql_dev` tool, which also defaults to read-only with an `allow_changes` opt-in.

## Read API (`/api/v1`) (Planned)

**Not yet implemented.** No `/api/v1` route, no `api` flag handling in the CRUD
generator, and no `apps/main/api/registry.ts` exist in the codebase - the design
below describes intended behavior, not shipped code. Everything in this section
is written in the present tense for readability; read it as a specification.

A read-only JSON API that serves generated-table data to **build-time consumers** (notably the `reeweb` static-site generator, which bakes the responses into static HTML and keeps zero DB dependencies of its own). Not a public API and not a runtime data layer.

- **`api` flag** - Per-table opt-in declared in `schema/table.ts`: `export const api = true;`. Default `false`. A table is reachable over the read API only when this is `true`; the CRUD generator adds the table to the API registry when it is set.
- **Endpoint shape** - `GET /api/v1/<table>` (list) and `GET /api/v1/<table>/:id` (single record). `<table>` is the **DB table name** (globally unique), not the route prefix path - e.g. the `partners` table (under the `user/` route prefix) is served at `/api/v1/partners`, never `/api/v1/user/partners`.
- **List params** - `limit` (default 20, hard cap 100), `offset` (default 0), `order_by` (optional, e.g. `id::desc`, falls back to `id::asc`). No `search` / `scope` / `filters` in v1.
- **Response envelope** - `{ data: Record[], total, limit, offset }`. `data` + `total` map onto `reeweb`'s paginator.
- **Sensitive blocklist** - A global constant of columns never serialized over the API (`hashed_password`, `previous_hashed_password`, `invitation_code`, `search_text`, `password_hash`). The handler strips these from `search_records`' `SELECT *` result before responding. This is why "automatic" exposure is safe even though `search_records` selects all columns and tables like `partners` carry a `hashed_password` field.
- **Dev-only mount** - The `/api/v1/*` routes are registered only in dev/agent mode (`is_dev`); they do not exist in the production route table. This is the "localhost only" guarantee - stronger than a bind-address or remote-IP check.
- **Mechanism** - One hand-written handler backed by a generated registry (`apps/main/api/registry.ts`, appended via a `// GEN:ROUTES` marker like `routes.ts`) mapping each enabled `table` to its `search_records` / `get_record_by_id`. Unknown or disabled table -> 404. No per-table `api.ts` handler is generated.
