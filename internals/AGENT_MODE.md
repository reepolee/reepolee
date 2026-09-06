# Agent Mode (`--agent`)

> Code is the source of truth. Confirm behavior in the relevant server entry point,
> `platform/auth/middleware.ts`, `lib/route_state.ts`, and `lib/server_startup.ts` before
> relying on this guide.

Agent mode is a local, headless development workflow for automated clients. It runs an app
on a dedicated loopback port and resolves an application user without performing the normal
login flow. Use it for controlled local automation, not as a production API or an
authentication substitute.

## Quick start

Set the Main agent port and a user that exists in the development database:

```dotenv
AGENT_SERVER_PORT=2500
AGENT_USER_USERNAME=admin
```

Start Main and make an authenticated request:

```bash
bun run agent
curl http://localhost:2500/system/users
```

The configured user must have the module access required by the route. For example,
`/system/users` requires a user with the `system` module.

## Commands and ports

Each application has its own agent command and required dedicated port. Agent commands start
their server with both `--dev` and `--agent`; none falls back to a normal application port.

| Target | Command | Required environment variable |
| --- | --- | --- |
| Main | `bun run agent` | `AGENT_SERVER_PORT` |
| Reeman | `bun run agent:reeman` | `AGENT_REEMAN_SERVER_PORT` |
| ReeQA | `bun run agent:reeqa` | `AGENT_REEQA_SERVER_PORT` |
| Main and Reeman together | `bun run dev:all:agent` | `AGENT_SERVER_PORT` and `AGENT_REEMAN_SERVER_PORT` |

`dev:all:agent` starts Main, Reeman, and the Main CSS watcher. It does not start ReeQA;
start ReeQA separately with `bun run agent:reeqa` when required.

The checked-in `.env.example` leaves the agent ports at `N/A`. A local configuration can use:

```dotenv
AGENT_SERVER_PORT=2500
AGENT_REEMAN_SERVER_PORT=2501
AGENT_REEQA_SERVER_PORT=2502
AGENT_USER_USERNAME=admin
AGENT_SECRET=N/A
```

## Identity and secret handling

Agent requests never use the normal session-cookie lookup. The middleware obtains an identity
only after validating the optional shared secret:

1. If `AGENT_SECRET` is `N/A` or unset, use `X-Agent-User-Username` when supplied;
   otherwise use `AGENT_USER_USERNAME`.
2. If `AGENT_SECRET` is set, a request that supplies `X-Agent-User-Username` must also supply
   a matching `X-Agent-Secret`. An invalid or missing secret causes the request to be anonymous;
   it does not fall back to `AGENT_USER_USERNAME`.
3. The selected username is looked up in the database. An unknown user is anonymous and a
   protected route follows its normal unauthenticated response path.

Use headers when an automated client needs to act as different users:

```bash
curl http://localhost:2500/system/users \
  -H "X-Agent-User-Username: admin" \
  -H "X-Agent-Secret: local-development-secret"
```

Omit the `X-Agent-Secret` header when `AGENT_SECRET=N/A`. Do not use a shared or production
secret for local agent mode.

## Safety boundary

- Agent mode is allowed only with `--dev`; server entry points reject `--agent` without it.
- Agent servers bind to `127.0.0.1`, not `0.0.0.0`.
- CSRF middleware is excluded and session cookies are bypassed.
- Do not expose an agent port through a reverse proxy, tunnel, container port mapping, or any
  network listener that can be reached by an untrusted process.
- Use a dedicated development database and an account with only the permissions the automation
  needs.

## Verification

After starting a target, use `curl` or the automation client against its dedicated localhost
port. Verify both an anonymous route and a route requiring the configured user, then run the
relevant unit or integration tests from [Testing](TESTING.md).

`bun run smoke:integration` is the normal server smoke test. Although its script accepts an
`--agent` argument, it currently starts Main with `--prod --test --agent`; Main rejects agent
mode without `--dev`. Do not use `bun run smoke:integration --agent` as an agent-mode check
until that runtime contract is changed and the script is updated.

## Key files

| File | Role |
| --- | --- |
| `apps/main/server.ts` | Validates Main agent mode and uses `AGENT_SERVER_PORT`. |
| `apps/reeman/server.ts` | Validates Reeman agent mode and uses `AGENT_REEMAN_SERVER_PORT`. |
| `apps/reeqa/server.ts` | Validates ReeQA agent mode and uses `AGENT_REEQA_SERVER_PORT`. |
| `scripts/dev_run.ts` | Starts Main and Reeman together for `dev:all:agent`. |
| `platform/auth/middleware.ts` | Resolves header or environment identity and verifies `AGENT_SECRET`. |
| `lib/route_state.ts` | Excludes CSRF middleware when `is_agent` is true. |
| `lib/server_startup.ts` | Binds agent servers to the loopback interface. |
