# apps/main/ - Route System

> **CODE IS THE SOURCE OF TRUTH.** This is a map. Read the handler, its `sql.ts`, and the
> `.ree` templates before changing anything.
>
> **Most route folders under here are GENERATED.** Within the Reepolee source repository,
> generated CRUD output is maintained through [generator/](../../generator/AGENTS.md) and
> regeneration. Hand-written system routes (under `system/`) are the exception. See
> [internals/AGENT_CRUD_WORKFLOW.md](../../internals/AGENT_CRUD_WORKFLOW.md) before editing CRUD code.

## How routing works

> Verify against `lib/route_builder.ts` and `apps/main/routes.ts` - the shape below is read
> from that code, not assumed.

- Handlers export named `async function handler_name(req: BunRequest): Promise<Response>` (the `Handler` type in `lib/middleware/types.ts` is `(req: BunRequest) => Response | Promise<Response>`).
- Each route module exports `export const route_definitions: RouteDefinition[]` (type from `$lib/route_builder`). `apps/main/routes.ts` aggregates every module's `route_definitions`, including explicitly mounted development modules outside `apps/main/`, and builds the table via `build_routes()` / `build_nav_routes()`.
- A `RouteDefinition` has a required `url` plus **one** of `handler` / `methods` (a `Record<string, Handler>`) / `resource` / `crud`, and optional `nav_title_key`, `module`, `is_menu_entry`.
- For a `crud` entry, `build_routes()` derives the mount prefix from `url` and applies `mount_prefix()`.
- Return HTML via `render("template", { data, ctx })` from `$lib/render`; `ctx` comes from `create_ctx(req, import.meta.dir)`. Helpers are auto-injected.
- Multi-file modules (auth, email) stay as barrel-exported objects - don't decompose them into individual flat-array entries.
- Path/slash and nav-key rules: see the Path/Slash convention in the root [AGENTS.md](../../AGENTS.md).

## Layout

| Path                  | Role                                                           |
| --------------------- | -------------------------------------------------------------- |
| `routes.ts`           | The route registry - aggregates module `route_definitions: RouteDefinition[]`. Appended by generators. |
| `types.ts`            | Shared route types                                             |
| `home/`               | Home page                                                      |
| `examples/`           | Example routes: `kitchen_sink/`, `signals/` |
| `system/`             | Hand-written admin/system routes (see below)                  |
| `<table>/`            | **Generated** CRUD route folders                              |

## `system/` routes (hand-written)

| Folder  | Purpose                                                            |
| ------- | ----------------------------------------------------------------- |
| `auth/` | Login, logout, register (invite-only), profile, password, invite. Multi-file barrel module. Session-type stack: `types.ts` -> `sql.ts` -> `helpers.ts` -> `middleware.ts`. |

The former admin pages under `system/` (users, images, files, queues, translations,
global_scopes, modules, rate_limits, cache) moved to `apps/reeman/` and are served by
the reeman app (`apps/reeman/server.ts`) at root URLs, gated by the "system" module.

## Generated CRUD folder structure

```
apps/main/<table>/
├-- schema/
│   ├-- table.generated.ts   # auto-generated field defs + TS types
│   ├-- table.ts             # user-editable: fields, v_fields, columns, route_param
│   └-- validation_server.ts # Zod validation
├-- {locale}.json            # co-located UI translations, one file per locale
├-- index.ts                 # CRUD handlers
├-- sql.ts                   # CRUD queries
├-- sql_view.ts              # view-based queries (if a view exists)
├-- form.ree                 # create/edit form
└-- index.ree                # list/index page
```

- `route_param` (in `schema/table.ts`) selects the column used for URL routing (default `"id"`). See [README.md](../../README.md) "route_param".
- Translations are co-located `{locale}.json` files. Edit the files directly or use `/translations` in Reeman. See the root [AGENTS.md](../../AGENTS.md) translation policy.

## Templates & components

`.ree` templates use the engine documented in [internals/REE_TEMPLATES.md](../../internals/REE_TEMPLATES.md).
Reusable components (form inputs, dialogs, filters) live in [components/](../../components/) and
are invoked as ReeTags (e.g. `<input-text>`, `<confirm-dialog>`, `<ree-filters>`).
