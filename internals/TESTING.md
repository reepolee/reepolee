# Testing

> Code is the source of truth. This describes the intended patterns; verify against the
> actual `*.test.ts` files and `test_helpers.ts` before relying on any detail here.

The test suite runs with Bun's built-in test runner. All test files use the `.test.ts`
extension and are **co-located** with source files - a test for `lib/helpers.ts` lives at
`lib/helpers.test.ts`.

## Running tests

```bash
bun test                      # Full suite (script: bun test --parallel)
bun test --watch              # Watch mode (Bun native flag; there is no test:watch script)
bun test lib/helpers.test.ts  # Single file
bun test --verbose            # Verbose output with test names
bun test:coverage             # Coverage report (script: bun test --parallel --coverage)
```

## Test file structure

- **Location:** Tests sit next to their source files (`lib/*.test.ts` next to `lib/*.ts`). This keeps imports simple (`./helpers` instead of `../../lib/helpers`).
- **Naming:** `*.test.ts` - Bun's test runner discovers these recursively.
- **No `*_additions.test.ts` files:** All addition test files have been merged into their canonical counterparts. Add tests to the existing canonical file for that module.
- **Generator tests** live in `generator/crud/` (e.g., `output.test.ts`, `schema_reader.test.ts`).
- **Server tests** live at `server.test.ts` (project root).

## Shared fixtures (`test_helpers.ts`)

`test_helpers.ts` at project root provides reusable mocks. Import via the `$root` alias:

```typescript
import { mock_db, mock_auth_middleware, mock_req, with_temp_dir, init_html_global } from "$root/test_helpers";
```

| Export                     | Purpose                                                                                                                                                                       |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mock_db()`                | Returns `{ db, close_db, DATE_TZ, TIME_TZ, DATETIME_TZ, TIMESTAMP_TZ }`. `db.unsafe()` returns `[]`, `db.run()` is no-op. All TZ constants set to `"UTC"`.                    |
| `mock_db_real(db)`         | Returns full `$config/db` shape including `db_cli`, `close_db_cli`, `sync_db_cli` for use with real in-memory SQLite instances. Pass a `new SQL(":memory:")` as the argument. |
| `get_test_db_connection()` | Connects to the MySQL test DB via `TEST_CONNECTION_STRING` (from `$config/test_db`). Fails loud if not set or DB name missing "test". Use for integration tests.              |
| `make_test_db_mock(db)`    | Wraps a real Bun SQL connection in the full `$config/db` mock shape for `mock.module("$config/db", ...)`. No-op close methods, TZ set to "UTC".                               |
| `mock_auth_middleware()`   | Returns `{ resolve_session, require_auth, require_module }`. All are no-op functions returning null.                                                                          |
| `mock_req(headers?)`       | Creates a minimal BunRequest-like object with `headers: Map` and `url: "http://localhost/test"`.                                                                              |
| `with_temp_dir(fn)`        | Creates a temp dir, runs the async callback with the dir path, then cleans up in `finally`.                                                                                   |
| `init_html_global()`       | Sets `(globalThis as any).html = String.raw` - required before template/helper tests that use tagged templates.                                                               |
| `setup_template_mocks()`   | Convenience: calls `init_html_global()` + `mock.module("$config/db", mock_db)` + `mock.module("$root/routes/system/auth/middleware", mock_auth_middleware)`.                  |

## Mock patterns

**`mock.module()`** must be called at the **top level** of the test file (not inside
`describe`/`test`), before any `import()` calls:

```typescript
import { mock, describe, expect, test } from "bun:test";
import { mock_db, mock_auth_middleware } from "$root/test_helpers";

mock.module("$config/db", mock_db);
mock.module("$root/routes/system/auth/middleware", mock_auth_middleware);

const module_under_test = await import("./module");
```

**Dynamic `import()`** - Always use `await import("./module")` after `mock.module()` so the
mocked module is used instead of the cached real one. Bun caches ES module instances per
process; multiple dynamic imports of the same module return the same instance.

**Mocking `process.exit`** - For fail-loud code paths:

```typescript
test("fails loud", () => {
	const original_exit = process.exit;
	(process as any).exit = ((code?: number) => {
		throw new Error(`process.exit(${code})`);
	}) as any;
	try {
		expect(() => risky_function()).toThrow("process.exit(1)");
	} finally {
		(process as any).exit = original_exit;
	}
});
```

**Mocking `globalThis.fetch`** - Restore in `finally`:

```typescript
test("mocks fetch", async () => {
	const original = globalThis.fetch;
	globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }));
	try {
		// ... assertions ...
	} finally {
		globalThis.fetch = original;
	}
});
```

**Mock rate limit store** - Rate limit tests use a `RateLimitStore` interface with `incr`, `expire`, `get`. The same contract is implemented by both the Redis and SQL stores, so the algorithm tests never touch either:

```typescript
function mock_store(overrides?: Partial<RateLimitStore>): RateLimitStore {
	return { incr: async () => 1, expire: async () => {}, get: async () => null, ...overrides };
}
```

The SQL store itself is tested against a real database in `lib/middleware/rate_limit_store_sql.test.ts`, including a 50-way concurrent `incr` that proves the atomic upsert closes the lost-update race.

## Environment variable handling

- **Avoid DB connections:** Set `CONNECTION_STRING=''` in unit tests that don't need a real database.
- **Separate PORT:** Use a port other than `2338` for integration tests.
- **TIME_ZONE:** Tests depending on timezone formatting mock `DATE_TZ`, `TIME_TZ`, `DATETIME_TZ`, `TIMESTAMP_TZ` via `mock_db()` (default `"UTC"`).
- **`afterEach` cleanup:** Restore modified env vars to prevent cross-test pollution.

## Template engine testing pattern

`TemplateEngine` is instantiated directly with a temp directory as the views root:

```typescript
const TE = (await import("./template_engine")).default;

function make_engine(views: string) {
	return new TE({ views, cache: false, ext: ".ree" });
}
```

- `engine.renderString(template, data)` - inline template compilation (no file needed)
- `engine.render("template_name", data)` - file-based rendering (write `.ree` files to temp dir)
- `engine.loadLocalized` - language-aware loading tests
- Template engine tests use the real filesystem (temp dirs), not mocks.

## Render function testing pattern

`render()` from `$lib/render` needs `initialize_render()` called with a mock engine first:

```typescript
mock.module("$config/db", mock_db);
mock.module("$root/routes/system/auth/middleware", mock_auth_middleware);

test("render returns Response", async () => {
	const engine = { render: async (name: string, data: any) => "<html>" + name + "</html>" };
	const { initialize_render, render } = await import("./render");
	initialize_render(engine, { is_dev: false });
	const result = await render("test", { data: {}, status: 200 });
	expect(result).toBeInstanceOf(Response);
});
```

## CRUD generator testing pattern

Generator tests use in-memory SQLite for DB-dependent paths and temp directories for output:

```typescript
import { mock_db_real } from "$root/test_helpers";

const test_db = new SQL(":memory:");
await test_db.unsafe(`CREATE TABLE test_items (...)`);
mock.module("$config/db", () => mock_db_real(test_db));
```

CRUD output tests verify generated file structure (sql.ts, index.ts, form.ree, index.ree)
rather than running the full pipeline. Use `afterEach` for cleanup with a `cleanups` array.

## Server integration testing pattern

`server.test.ts` mocks 10+ config/service modules to test the server module without booting
a full HTTP server (avoids PID files, S3 checks, Redis connections):

| Module                        | Purpose                |
| ----------------------------- | ---------------------- |
| `$config/supported_languages` | Language config        |
| `$config/db`                  | DB access (empty mock) |
| `$routes/routes`              | Route definitions      |
| `$lib/livereload`             | Hot reload (disabled)  |
| `$lib/modules`                | Module system          |
| `$lib/logger`                 | File logging           |
| `$lib/s3`                     | S3 storage             |
| `$lib/local_storage`          | Local storage          |
| `$lib/feature_flags`          | Feature flags          |
| `$queue/index`                | Background job queue   |

## MySQL integration tests

Use the real MySQL test DB cloned via `bun run db:clone-test`. Set `TEST_CONNECTION_STRING`
in `.env` to a database with "test" in its name. The guard in `config/test_db.ts` refuses
non-test databases. Use transactions for isolation:

```typescript
import { get_test_db_connection, make_test_db_mock } from "$root/test_helpers";

const test_db = get_test_db_connection();
mock.module("$config/db", () => make_test_db_mock(test_db));

beforeEach(async () => { await test_db.unsafe("START TRANSACTION"); });
afterEach(async () => { await test_db.unsafe("ROLLBACK"); });
```

## Test isolation (`--parallel`)

Bun runs tests in a single process by default, so all test files share the module cache,
`Bun.env`, and `process.cwd`. The `--parallel` flag spawns a separate worker per test file,
giving full isolation. This is required because:

- `mock.module()` applies globally per process - once a module is loaded, it can't be re-mocked by another test file.
- `process.cwd` changes in one file persist to subsequent files.
- `Bun.env` modifications in one file leak into others.

```bash
bun test                # Uses --parallel (configured in package.json)
bun test --no-parallel  # Single process (may have cross-file interference)
```

### `mock.module()` conflict map

Each module path can only be mocked **once** per process. Modules mocked by multiple test
files (resolved by `--parallel` giving each file its own worker):

| Module path                           | Conflict |
| ------------------------------------- | -------- |
| `$config/db`                          | **HIGH** - two incompatible mock types: `mock_db()` (empty void queries) vs `mock_db_real(test_db)` (real in-memory SQLite). |
| `$config/supported_languages`         | **MEDIUM** - similar configs, may differ in `language_names` keys. |
| `$config/db_structure`                | **LOW** - similar structure constants. |
| `$root/routes/system/auth/middleware` | **LOW** - all use shared `mock_auth_middleware()`. |
| `$root/routes/system/auth/cookies`    | **LOW** - same `get_session_id_from_request` pattern. |

## Date/time assertion guidelines

- **Prefer specific expected values** over `toBeTruthy()` when the locale is known.
- For `en-US` locale with `UTC` timezone, formats are deterministic:
    - `js_date_to_locale_string`: `"MM/DD/YY"` (e.g., `"01/02/26"`)
    - `js_time_to_locale_string`: `"h:mm AM/PM"` (e.g., `"10:30 AM"`)
    - `js_datetime_to_locale_string`: `"MM/DD/YY, h:mm AM/PM"`
    - `js_timestamp_to_locale_string`: `"MM/DD/YY, h:mm:ss AM/PM"`
- Use `toBeTruthy()` only for locale-dependent tests (`sl-SI`, `de-DE`, no-locale) where the exact format varies by platform.

## Best practices

1. **Use `mock.module()` at top level**, before any `import()` statements.
2. **Use dynamic `import()`** to get fresh module state after mocking.
3. **Use `test_helpers.ts`** for shared mocks - don't duplicate them in individual files.
4. **Do not create `*_additions.test.ts` files** - add tests to the canonical file.
5. **Prefer specific assertions** (`toBe`, `toEqual`, `toContain`) over `toBeTruthy()`/`toBeDefined()` where deterministic.
6. **Use temp directories** (`mkdtempSync` + `rmSync`, or `with_temp_dir()`) for filesystem-dependent tests.
7. **Clean up env vars** in `afterEach`.
8. **Keep tests fast** - avoid network calls, real DB connections, or filesystem-heavy ops in unit tests.
9. **Use `CONNECTION_STRING=''`** when running tests that must not hit the database.
10. **Export pure functions for testing** where possible (see `lib/middleware/rate_limit.ts`).
