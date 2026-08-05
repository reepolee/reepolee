# Agent Mode (`--agent`)

> Code is the source of truth. Confirm behaviour in `server.ts` and
> `routes/system/auth/middleware.ts` before relying on details here.

The `--agent` flag enables a headless/automation mode for the dev server. It disables CSRF
and session cookies so the server can be accessed via `curl`, browser-use, or other
automated tools without going through the login flow.

## Quick start

```bash
# Start the server in agent mode (uses package.json "agent" script)
AGENT_USER_USERNAME=admin AGENT_SERVER_PORT=2500 bun run agent

# Curl a protected route (no CSRF token, no login needed)
curl http://localhost:2500/system/users -H "X-Agent-User-Username: admin"
```

## How auth works

Authentication is resolved in this priority order (first non-empty wins):

| Priority | Source                                | Example                                             |
| -------- | ------------------------------------- | --------------------------------------------------- |
| 1        | `X-Agent-User-Username` request header | `curl -H "X-Agent-User-Username: admin" ...`       |
| 2        | `AGENT_USER_USERNAME` env var          | `AGENT_USER_USERNAME=admin bun run agent`           |
| 3        | (fallback)                             | Continues as anonymous (normal session cookie flow) |

The username is looked up via `get_user_by_username()`. If found, `resolve_session()` returns a
fake session with the user's `User_public` data. If not found, a warning is logged and the
request continues as anonymous (redirected to login for protected routes).

## Env vars

| Env var             | Purpose                                                            | Example                              |
| ------------------- | ------------------------------------------------------------------ | ------------------------------------ |
| `AGENT_USER_USERNAME` | Default authenticated user for all agent-mode requests           | `AGENT_USER_USERNAME=admin`         |
| `AGENT_SERVER_PORT`   | **Required.** Port to run the agent server on (avoids conflict with dev on 2338). The server exits at startup when `--agent` is passed without it - no silent fallback to `PORT` / 2338. | `AGENT_SERVER_PORT=2500`           |

## Safety

`--agent` is **only allowed with `--dev`**. Running `--agent` without `--dev` exits
immediately with an error:

```
✗ --agent flag is only allowed with --dev (development mode)
```

`--agent` also **requires `AGENT_SERVER_PORT`**. Without it the server exits immediately
instead of silently falling back to `PORT` / 2338 (the developer's port):

```
✗ --agent requires AGENT_SERVER_PORT to be set in .env (e.g. AGENT_SERVER_PORT=2500)
```

Agent mode **binds exclusively to `127.0.0.1` (localhost)**, not `0.0.0.0`. Only processes
on the same machine can reach the unprotected agent-mode server. This binding is configured
in `lib/server_helpers.ts` (`start_server()`): `const hostname = is_agent || is_test ? "127.0.0.1" : "0.0.0.0"`.

## What changes in agent mode

| Concern        | Normal                                                   | Agent mode                                                   |
| -------------- | -------------------------------------------------------- | ------------------------------------------------------------ |
| CSRF           | Double-submit cookie token validation on POST/PUT/DELETE | **Disabled** - `csrf_mw()` excluded from middleware pipeline |
| Session cookie | `sid` cookie required for auth                           | **Bypassed** - header or env var provides identity           |
| Auth           | Login flow -> session store                              | `X-Agent-User-Username` header or `AGENT_USER_USERNAME` env var |

## Key files

| File                               | Role                                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------------- |
| `server.ts`                        | Detects `--agent` (`is_agent = Bun.argv.includes("--agent")`), enforces dev-only safety, applies `AGENT_SERVER_PORT`, passes `is_agent` through |
| `lib/route_state.ts`               | `rebuild_routes_and_state(...)` appends `csrf_mw()` only when `!is_agent` - the actual CSRF exclusion |
| `routes/system/auth/middleware.ts` | `resolve_session()` resolves user via header/env var, returns fake session              |
| `package.json`                     | `"agent"` script: `bun css:build && bun --hot server.ts --dev --agent`                  |

## Testing scenarios

```bash
# 1. Server running with env var auth (no header needed per-request)
AGENT_USER_USERNAME=ales AGENT_SERVER_PORT=2500 bun run agent

# 2. Protected route - auth via env var (no header):
curl http://localhost:2500/system/users             # -> 200 (env var provides auth)

# 3. Protected route - header overrides env var:
curl http://localhost:2500/system/users -H "X-Agent-User-Username: other_user"  # -> 200 or 303

# 4. Protected route - unknown user:
curl http://localhost:2500/system/users -H "X-Agent-User-Username: nobody"  # -> 303 redirect to login
```
