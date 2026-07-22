# generator/user - Dev User Creator CLI Spec

## Overview

A lightweight CLI helper under `generator/` that creates a confirmed (verified) user directly in the database - no invitation flow, no web UI. Intended as a **dev helper** for quickly bootstrapping accounts during development.

## Usage

```bash
bun generator/user <email> <password> [--tags <tag1,tag2>]
```

### Arguments

| Position | Name       | Required | Description                                            |
| -------- | ---------- | -------- | ------------------------------------------------------ |
| 1        | `email`    | Yes      | User's email address (also becomes unique identifier)  |
| 2        | `password` | Yes      | Plain-text password (hashed via `Bun.password.hash()`) |

### Flags

| Flag     | Default | Description                                      |
| -------- | ------- | ------------------------------------------------ |
| `--tags` | `user`  | Comma-separated tags, e.g. `--tags admin,editor` |
| `--help` | -       | Print usage and exit                             |

## Behavior

1. **Email check** - If a user with the given email already exists in the `users` table, print an error and exit with code 1. No changes are made.
2. **Display name** - Derived from the local part of the email (everything before `@`). E.g. `jane.doe@example.com` → `name = "jane.doe"`.
3. **Nickname** - Left as empty string `""`.
4. **Password** - Hashed via `Bun.password.hash(password)`.
5. **Verified** - `verified_at` is set to the current UTC timestamp via `instant_to_sql()`.
6. **Invitation code** - Set to empty string `""` (no invite used, user is directly created).
7. **Tags** - Defaults to `"user"`. Override with `--tags` flag (comma-separated, stored as-is).
8. **Maintenance fields** - `created_at` is set to current timestamp; `updated_at` is set to current timestamp and will be updated by the DB trigger later.
9. **`previous_hashed_password`** - Left as `null`.
10. **Avatar filename** - Left as empty string `""`.

## Output

On success, print a single line to stdout:

```
✓ Created user jane@example.com
```

No JSON, no verbose logging. Quiet and script-friendly.

On error (email exists), print to stderr:

```
✗ User jane@example.com already exists
```

Exit with code 1.

## Implementation notes

### File

`generator/user.ts` - standalone single-file script. Does not need to be registered in `routes.ts` or anywhere else.

### Shebang

```ts
#!/usr/bin/env bun
```

### Imports

```ts
import { db } from "$config/db";
import { instant_to_sql } from "$lib/temporal";
```

### DB query

Use Bun's native SQL tagged template API (`db\`...\``) to INSERT into the `users` table:

```sql
INSERT INTO users (email, name, nickname, avatar_filename, verified_at, hashed_password, invitation_code, tags, created_at, updated_at)
VALUES (${email}, ${name}, ${nickname}, ${avatar_filename}, ${verified_at}, ${hashed_password}, ${invitation_code}, ${tags}, ${created_at}, ${updated_at})
```

Use `instant_to_sql()` (from `$lib/temporal`) to generate `verified_at`, `created_at`, and `updated_at` values.

### Duplicate check

```sql
SELECT id FROM users WHERE email = ${email} LIMIT 1
```

If a row is returned, error out.

### Password hashing

```ts
const hashed_password = await Bun.password.hash(password);
```

Uses bcrypt (Bun's default algorithm).

### Argument parsing

Manual parsing of `process.argv.slice(2)`. The `--tags` flag is split on commas. The `--help` flag prints usage.

Look for the `--tags` flag with its value in the next argument, then filter it out when extracting positional args.

### Conventions

- **snake_case** for variables and function names
- **Prefix**: `$config/` and `$lib/` path aliases from `tsconfig.json`
- **Shebang**: `#!/usr/bin/env bun`
- Follow existing generator patterns (see `generator/crud.ts`, `generator/add_language.ts`)

### Error handling

- If no DB connection or DB error occurs, print the error to stderr and exit with code 1.
- If email is missing, print usage and exit with code 1.
- If password is missing, print usage and exit with code 1.
- If email already exists, print error to stderr and exit with code 1.

## Non-goals (explicitly out of scope)

- No session creation or Set-Cookie logic
- No email sending
- No web UI or form rendering
- No route registration in `routes.ts`
- No translation file generation
- No validation beyond email uniqueness and presence checks
- No password strength requirements (dev helper - accept any non-empty string)

## DB table reference

The `users` table structure (from `init-mysql.sql` / `init-sqlite.sql`):

| Column                     | Type             | Default             | Notes                                      |
| -------------------------- | ---------------- | ------------------- | ------------------------------------------ |
| `id`                       | INT / INTEGER    | AUTO_INCREMENT      | Primary key                                |
| `email`                    | VARCHAR(255)     | -                   | Unique, lowercase, the user's identifier   |
| `name`                     | VARCHAR(80)      | `''`                | Display name, derived from email           |
| `nickname`                 | VARCHAR(20)      | `''`                | Left empty                                 |
| `avatar_filename`          | VARCHAR(250)     | `''`                | Left empty                                 |
| `verified_at`              | DATETIME / TEXT  | `NULL`              | Set to current timestamp (confirmed user)  |
| `hashed_password`          | VARCHAR(255)     | `NULL`              | bcrypt hash of the provided password       |
| `invitation_code`          | VARCHAR(64)      | `''`                | Set to empty string (no invite)            |
| `tags`                     | VARCHAR(255)     | `'user'`            | Default `'user'`, overridable via `--tags` |
| `previous_hashed_password` | VARCHAR(255)     | `NULL`              | Left null                                  |
| `created_at`               | TIMESTAMP / TEXT | `current_timestamp` | Set explicitly to current timestamp        |
| `updated_at`               | TIMESTAMP / TEXT | `NULL`              | Set explicitly to current timestamp        |

## Integration testing

### Strategy

The `generator/user.ts` script directly interacts with the database (INSERT + SELECT). Testing it requires either:

**Option A - Extract a pure function (recommended):**
Move the core logic into an exported `create_user()` function in a separate module (e.g. `generator/user_lib.ts`), then have `generator/user.ts` be a thin CLI wrapper that calls it. This lets tests import `create_user()` and mock the DB via Bun's `mock.module()`, matching the pattern already established in `lib/helpers.test.ts`.

```ts
// generator/user_lib.ts (exported, testable)
export async function create_user(
	email: string,
	password: string,
	tags: string = "user",
): Promise<{ email: string }> { ... }

// generator/user.ts (CLI wrapper)
import { create_user } from "./user_lib";
const [_email, _password] = parse_args();
await create_user(_email, _password, tags);
```

**Option B - Inline + `bun test` with a temp SQLite DB:**
Use the `--dev` flag and a dedicated test database (SQLite in a temp file) via `bun test` + `mock.module("$config/db")` to inject a test connection. The project's existing init SQL (`init-sqlite.sql`) provides the `users` table DDL.

### Test file

`generator/user.test.ts` - co-located with the source.

### Test cases

#### Argument parsing (unit tests, no DB needed)

| Test                   | Input                                                         | Expected result                                                              |
| ---------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Valid args             | `['jane@example.com', 'secret123']`                           | `{ email: "jane@example.com", password: "secret123", tags: "user" }`         |
| Valid args with --tags | `['jane@example.com', 'secret123', '--tags', 'admin,editor']` | `{ email: "jane@example.com", password: "secret123", tags: "admin,editor" }` |
| Missing email          | `[]`                                                          | Error: print usage, exit code 1                                              |
| Missing password       | `['jane@example.com']`                                        | Error: print usage, exit code 1                                              |
| --help flag            | `['--help']`                                                  | Print usage, exit code 0                                                     |

#### DB interaction (with a temp SQLite DB)

| Test                     | Setup                              | Action                                        | Expected result                                                                            |
| ------------------------ | ---------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Creates a new user       | DB empty                           | `create_user("test@example.com", "pass123")`  | Row inserted, `verified_at` is not null, `name = "test"`                                   |
| Duplicate email rejected | Seed user `test@example.com` in DB | `create_user("test@example.com", "other")`    | Error: user already exists, no new row                                                     |
| Custom tags applied      | DB empty                           | `create_user("x@y.com", "p", "admin,editor")` | Row has `tags = "admin,editor"`                                                            |
| Default tags applied     | DB empty                           | `create_user("x@y.com", "p")`                 | Row has `tags = "user"`                                                                    |
| Password is hashed       | DB empty                           | `create_user("x@y.com", "secret")`            | `hashed_password` is not null and `Bun.password.verify("secret", hashed_password)` is true |
| Email is lowercased      | DB empty                           | `create_user("JANE@Example.COM", "p")`        | Row has `email = "jane@example.com"`                                                       |
| Display name from email  | DB empty                           | `create_user("jane.doe@example.com", "p")`    | Row has `name = "jane.doe"`                                                                |

### DB test infrastructure

Create a helper in `generator/test_helpers.ts` (or inline in the test file) that:

1. Creates a temporary SQLite database file via `:memory:` or `mkdtempSync`
2. Runs the `users` table DDL from `init-sqlite.sql` against it
3. Returns the `db` instance for use in tests
4. Provides a `seed_user()` helper for the duplicate-email test
5. Cleans up after all tests via `afterAll`

```ts
// generator/user.test.ts (conceptual structure)
import { describe, expect, test, afterAll, mock } from "bun:test";

// Mock $config/db to point to a temp SQLite DB
const test_db = new SQL(":memory:");
// Run users table DDL
await test_db.unsafe(`CREATE TABLE users (...)`);
mock.module("$config/db", () => ({ db: test_db }));

// Mock $lib/temporal to return a fixed timestamp for deterministic tests
mock.module("$lib/temporal", () => ({
	instant_to_sql: () => "2026-01-15 12:00:00",
}));

import { create_user } from "./user_lib"; // for option A

// ... test cases ...
```

### Running tests

```bash
bun test generator/user.test.ts
```

The test should use a **different PORT** (not 2338) if the test file also starts a server. For a pure unit test of `create_user()`, no server is needed - the test connects to the temp DB directly.

### Existing test conventions to follow

- Use `bun:test` (`describe`, `expect`, `test`, `mock`, `afterAll`)
- Mock DB-dependent modules to avoid triggering the live project DB connection
- Use `mock.module()` to intercept module-level imports (pattern from `lib/helpers.test.ts`)
- Use `Bun.password.verify()` to assert password hashing works
- Keep tests deterministic - no reliance on current timestamps for assertions; either mock `instant_to_sql` or assert structural properties (e.g. `verified_at` is not null rather than checking exact value)
