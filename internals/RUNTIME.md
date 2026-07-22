# Runtime & Operations

> Code is the source of truth. Each subsystem links to its implementation - read that code
> (and its `*.test.ts`) before relying on details here.

- [Git hooks](#git-hooks)
- [Dev mode quirks](#dev-mode-quirks)
- [SQL connection-pool gotcha](#sql-connection-pool-gotcha)
- [Redis](#redis)
- [Rate limiting](#rate-limiting)
- [Global scopes with session variables](#global-scopes-with-session-variables)
- [Load testing](#load-testing)
- [Release to the web](#release-to-the-web)

## Git hooks

The project ships a pre-commit hook at `.githooks/pre-commit` that runs on every `git commit`.

```bash
bun run git:hooks   # git config core.hooksPath .githooks
```

`.githooks/` is tracked in version control, so all developers get the same hooks once they
run setup. The hook runs two checks in sequence; **if either fails, the commit is aborted:**

1. **`reettier --git`** - formats dirty (git-tracked) files, then re-stages them with `git add -u`. Run first so formatting changes don't break the smoke test.
2. **`timeout 30 bun smoke:integration`** - runs `scripts/smoke-integration.ts` to verify the server boots, routes register, and the basic integration flow works. A timeout (exit 124) or non-zero exit aborts the commit.

Edit `.githooks/pre-commit` to add/remove checks (each check exits with code 1 to abort).
Add more hooks by placing executable scripts in `.githooks/` (e.g. `.githooks/pre-push`).
Bypass with `git commit --no-verify` (or `-n`) for WIP/emergency commits.

## Dev mode quirks

- **`bun dev`** runs `tailwindcss` and `bun --hot --no-clear-screen server.ts --dev` via `conc`. Template cache is disabled in dev and enabled in prod.
- **`bun run worker`** starts the background worker (`worker.ts`) separately when you need queue processing alongside the dev server.
- **`bun --hot`** reloads the process on code changes without clearing the terminal.
- Live reload SSE at `/__reload`; CSS output goes to `static/app-dev.css` (gitignored).
- Static files in `static/` are served directly.
- **`await prev_server.stop()`** - macOS holds the port in TIME_WAIT briefly, so the old server stop must be awaited before starting a new one across `--watch` reloads.
- **Translation sync timing:** to prevent premature restarts before translations are committed:
    - The CRUD generator defers writing `routes/routes.ts` until AFTER `sync_all_namespaces()` completes (stored in `_deferred_routes_content`, written just before `notify_server_reload()`).
    - The reeman calls `notify_server_reload()` after `sync_all_namespaces()` so the server picks up newly translated nav labels and CRUD keys.
    - For server restarts, `notify_server_reload()` appends a reload stamp to `routes/routes.ts` (not `server.ts`) so Bun `--watch` detects the change and restarts.

## SQL connection-pool gotcha

> **VERY IMPORTANT** for standalone scripts (not needed inside `Bun.serve()`).

Bun's native `sql` uses an internal connection pool. The pool's idle connections don't
register persistent I/O on the event loop - only things like `Bun.serve()` (an open server
socket) do. So in a standalone script:

1. Your first query runs -> promise resolves.
2. Event loop sees no more pending I/O -> process exits.
3. The SQL connection is torn down mid-execution.

Second queries silently never run, or you get `Connection closed`. Two workarounds:

**Option A - keep the loop alive with a dummy timer, exit manually:**

```typescript
import { sql } from "bun";

const db = sql`mysql://user:pass@localhost:3306/mydb`;
const stay_alive = setInterval(() => {}, 2_147_483_647);

async function run() {
	const users = await db`SELECT id, name FROM users`;
	const orders = await db`SELECT id, total FROM orders`;
	clearInterval(stay_alive);
	await db.end();
	process.exit(0);
}

run().catch((err) => { console.error(err); process.exit(1); });
```

**Option B - `sql.reserve()` to hold a dedicated, persistent connection:**

```typescript
import { sql } from "bun";

const db = sql`mysql://user:pass@localhost:3306/mydb`;

async function run() {
	const conn = await db.reserve();
	try {
		const users = await conn`SELECT id, name FROM users`;
		const orders = await conn`SELECT id, total FROM orders`;
	} finally {
		conn.release();
		await db.end();
		process.exit(0);
	}
}

run();
```

`reserve()` is better for transaction-level connection affinity (`BEGIN`/`COMMIT`); the
`setInterval` trick is simpler for fire-and-forget scripts. Both are unnecessary inside
`Bun.serve()`.

## Redis

See [CONTEXT.md](CONTEXT.md#redis) for glossary definitions. API docs:
`https://bun.com/reference/bun/RedisClient/{COMMAND_NAME}`.

Use the proper import syntax - never `Bun.RedisClient` or `(Bun as any).RedisClient`:

```typescript
import { redis } from "bun";        // default client (reads REDIS_URL env var)
import { RedisClient } from "bun";  // explicit client type
const client = new RedisClient("redis://..."); // custom connection
```

The default `redis` auto-connects from `REDIS_URL`. Connections are lazy - the first command
triggers connection. Key methods: `incr`, `get`, `set`, `del`, `expire`, `exists`, `hmset`,
`hmget`, `sadd`, `srem`, `smembers`, `send` (raw commands), `ping`, `close`.

## Rate limiting

Middleware `lib/middleware/rate_limit.ts` protects the server using a sliding-window counter
backed by Redis. See [CONTEXT.md](CONTEXT.md#rate-limiting) for terminology.

### Configuration (`config/rate_limit.ts`)

| Tier         | Limit | Window | Scope                                |
| ------------ | ----- | ------ | ------------------------------------ |
| `global`     | 300   | 60s    | All POST/PUT/PATCH/DELETE (fallback) |
| `login`      | 5     | 60s    | POST `/login`                        |
| `register`   | 3     | 60s    | POST `/register/*`                   |
| `password`   | 5     | 60s    | POST `/password`                     |
| `invite`     | 10    | 60s    | POST `/invite`                       |
| `validation` | 30    | 60s    | POST `*/validate`                    |

### Env var gating

Rate limiting is disabled by default for local development. Production requires
`RATE_LIMITING=true`, `REDIS_URL`, and `TRUST_PROXY=cloudflare`; startup exits when
any requirement is missing. Cloudflare deployments use `CF-Connecting-IP` for the
visitor identity. The origin firewall must allow only Cloudflare IP ranges, otherwise
a direct client could spoof this header.

- **Pipeline position:** first, then `set_lang()`, then `csrf_mw()`.
- **Algorithm:** INCR on current window key, GET previous window, weighted estimate.

### Exported for testing (`lib/middleware/rate_limit.ts`)

- `resolve_scope(pathname, method)` - scope resolution (pure)
- `extract_identity(req)` - client identity (pure)
- `rate_limited_response(retry_after, rule, reset_time, req)` - 429 response builder (pure)
- `check_rate_limit(scope, identity, rule, store?)` - sliding window counter (needs a rate limit store)

The store defaults to `resolve_rate_limit_store()`: Redis when `REDIS_URL` is set,
otherwise SQL via the `rate_limit_counters` table. Rate limiting therefore does not
require Redis in production.

Tests: `lib/middleware/rate_limit.test.ts` uses dependency injection (a `RateLimitStore`
interface) rather than mocking `bun`.

## Global scopes with session variables

Global scopes can reference the logged-in user's session data using `::session.*` tokens in
`where_clause`.

### Architecture

- **`lib/global_scopes.ts`** - core: `resolve_session_variables(clause, ctx?)` (exported, pure), `get_scope_clause(table_name, scope_key, ctx?, route_name?, module_code?)` (exported, async), `SESSION_VARIABLE_PATHS` (exported), private `SESSION_VARIABLES` registry and `sql_escape_literal()`.
- **`lib/global_scopes.test.ts`** - covers passthrough, fail-loud, auto-escaping, unknown/null variables, mixed SQL.
- **`routes/system/global_scopes/index.ts`** - form handlers pass `session_variables` (chips) and `user_options` (preview dropdown). Preview endpoint `POST /test-scope`.
- **`routes/system/global_scopes/form.ree`** - variable chip picker + collapsible "Preview resolved SQL".
- Session-type stack: `routes/system/auth/{types,sql,helpers,middleware}.ts`.
- **`generator/templates/index/index_get.ts`**, **`index_get_offset.ts`** - pass `ctx` to `get_scope_clause()`.

### Adding new session variables

Add an entry to `SESSION_VARIABLES` in `lib/global_scopes.ts`:

```ts
"session.user.new_field": (ctx) => ctx.user?.new_field ?? null,
```

If the field doesn't exist on `User_public` yet, add it through the session-types stack:
`types.ts` -> `sql.ts` -> `helpers.ts` -> `middleware.ts`.

### Delimiter convention

`::session.*` tokens are space-delimited. For `IN (...)` or `FIND_IN_SET()`, put a space
before punctuation:

```sql
FIND_IN_SET('admin', ::session.user.modules_tags )
author_id IN (::session.user.id , ::session.user.id )
```

### Preview UI

`POST /system/global_scopes/test-scope` takes `{ where_clause, test_user_id }`, returns
`{ resolved_clause }`. Available as the collapsible "Preview resolved SQL" on the scope edit form.

## Load testing

Ad-hoc throughput/latency checks use [`autocannon`](https://github.com/mcollina/autocannon)
(install globally: `bun add -g autocannon`). These are machine-specific - point the URL at
whatever host/port you are testing. They are kept here rather than in `package.json` because
the target host is not portable across dev machines.

```bash
# General throughput against a rendered route
autocannon -c 25 -d 15 --latency --renderStatusCodes http://<host>:<port>/frameworks

# Rate-limit behaviour against the login POST
autocannon -c 25 -d 15 -m POST --latency --renderStatusCodes http://<host>:<port>/login
```

## Release

`bun run release` bumps `package.json`, commits and pushes the bump, then delegates archive
packaging to the shared reelease project. It assumes the reelease repo exists next to this repo:

- `../reelease` - packaging logic (`.releaseignore`, `.override.*` files, hashing, tar);
    the archive is written to `../reelease/dist/` by default (`--output <dir>` overrides).

If that directory is not present the script fails; check out the reelease repo alongside this one
before running it.
