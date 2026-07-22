# Agent-safe CRUD Workflow

This document describes the exact workflow an agent should follow before editing or generating CRUD routes. Follow these steps to avoid corrupting generated code or introducing `db.unsafe()` violations.

---

## 1. Understand the architecture

CRUD routes are either **generated** (by `generator/crud.ts` + `generator/schema.ts`) or **hand-written system routes**.

| Aspect           | Generated CRUD                                                                                             | Hand-written system route                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Location         | `routes/<table>/` (non-system)                                                                             | `routes/system/*/`                                        |
| `db.unsafe()`    | Only in generated `search_records` (approved - see §3)                                                     | Only existing reviewed uses are permitted                 |
| Regenerate-safe? | Yes - `--force` overwrites                                                                                 | No - edit directly                                        |
| Templates used   | `generator/templates/sql.ts`, `sql_view.ts`, `nested_sql.ts`, `form.ree`, `index.ree`, `details_index.ree` | N/A                                                       |

---

## 2. Files to inspect before editing

Read **all** of these before touching any CRUD route:

### For a generated CRUD route (`routes/<table>/`)

| File                          | Purpose                                                                        | Edit-safe?                                   |
| ----------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------- |
| `schema/table.ts`             | Field definitions, `route_param`, `parent` export, `indexed_columns`           | **Yes** - user-editable                      |
| `schema/table.generated.ts`   | Auto-generated fields, `indexed_columns`, `TYPES`, `STORE`                     | **No** - overwritten on `--force`            |
| `schema/validation-server.ts` | Zod validation schemas                                                         | **No** - overwritten on `--force`            |
| `sql.ts`                      | SQL query functions (contains `db.unsafe()` in `search_records`)               | **No** - generated                           |
| `sql_view.ts`                 | View-based queries (if view exists)                                            | **No** - generated                           |
| `index.ts`                    | Route handlers                                                                 | **No** - generated                           |
| `form.ree`                    | Create/edit form template (has marker comments `<!-- crud:fields:start -->`)   | **Limited** - between markers is regenerated |
| `index.ree`                   | List/index template (has marker comments `<!-- crud:fields:headers:start -->`) | **Limited** - between markers is regenerated |
| `translations/`             | Generated DB translation keys, edited via `/system/translations` admin UI | **DB-only** - the `translations` table is the sole source of truth. See [AGENTS.md Translations](../AGENTS.md#translations-db-first-authoritative-policy) |

> **Note:** `routes/system/users/sql.ts` uses **offset-based pagination** (`LIMIT ? OFFSET ?`) and does not export `VIEW_DEPENDENCIES`. It is a hand-written system route, not a template for generated CRUD routes.

### For a hand-written system CRUD (`routes/system/<name>/`)

| File        | Purpose                             | Edit-safe?                                       |
| ----------- | ----------------------------------- | ------------------------------------------------ |
| `sql.ts`    | SQL queries (may use `db.unsafe()`) | **Yes** - but check db.unsafe() exceptions first |
| `index.ts`  | Route handlers                      | **Yes**                                          |
| `form.ree`  | Form template                       | **Yes**                                          |
| `index.ree` | List template                       | **Yes**                                          |

### Generator infrastructure

| File                                    | Purpose                                                    | Edit-safe?                                    |
| --------------------------------------- | ---------------------------------------------------------- | --------------------------------------------- |
| `generator/templates/sql.ts`            | Template for generated SQL (the actual `db.unsafe()` code) | **Yes** - affects all future generated routes |
| `generator/templates/sql_view.ts`       | Template for view-based SQL                                | **Yes**                                       |
| `generator/templates/nested_sql.ts`     | Template for nested child SQL                              | **Yes**                                       |
| `generator/templates/form.ree`          | Template for generated forms                               | **Yes**                                       |
| `generator/templates/index.ree`         | Template for generated index pages                         | **Yes**                                       |
| `generator/templates/details_index.ree` | Template for child inline lists                            | **Yes**                                       |
| `generator/crud/sql_ts.ts`              | Code that fills the templates                              | **Yes**                                       |
| `generator/crud/main.ts`                | CRUD orchestration                                         | **Yes**                                       |
| `generator/crud/render_field_cell.ts`   | Field cell rendering                                       | **Yes**                                       |
| `generator/schema/types.ts`             | Schema types                                               | **Yes**                                       |
| `generator/schema/introspector.ts`      | DB introspection                                           | **Yes**                                       |

---

## 3. The `db.unsafe()` rule

**Never introduce a new `db.unsafe()` call in hand-written code.**

Only the following are approved:

1. **Generator templates** (`generator/templates/sql.ts`, `sql_view.ts`, `nested_sql.ts`) - these produce safe generated code where `sort_field` is validated via `/^[a-zA-Z_][a-zA-Z0-9_]*$/` and `sort_direction` is clamped to `['asc', 'desc']`.

2. **Infrastructure tools** (generator code, test setup, MCP server) - these never process user input in SQL strings.

3. **Existing hand-written system CRUD routes** - do not add `db.unsafe()` calls to them. Keep any required dynamic SQL confined to the reviewed generator templates.

### Safe alternative patterns

Instead of `db.unsafe()`, use Bun's tagged template SQL:

```typescript
// ✅ Safe - Bun's SQL API parameterizes automatically
const records = await db`SELECT * FROM users WHERE email = ${email}`;

// ❌ Unsafe - use only in approved templates with sort_field validation
const query = `SELECT * FROM users ORDER BY ${sort_field} ${direction} LIMIT ?`;
```

---

## 4. Editing steps checklist

When asked to modify or fix a CRUD route:

1. **Identify** whether it's generated or hand-written
2. **Read** all relevant files from §2
3. **Check** if the fix belongs in the generator template (affects all future routes) or the specific file
4. **Validate** that `db.unsafe()` is not being introduced
5. **Regenerate** if modifying generated files: `bun generator/resource.ts <table> --force`
6. **Test** with `bun test`

---

## 5. Common pitfalls

- **Editing `table.generated.ts`**: This file is overwritten by `--force`. Edit `table.ts` instead.
- **Adding new fields to a generated CRUD**: Regenerate via resource generator, don't edit files manually.
- **Using `db.unsafe()` for dynamic queries**: Use the validated sort_field pattern from templates or refactor to avoid dynamic SQL entirely.
- **Editing between marker comments**: In `form.ree` and `index.ree`, content between `<!-- crud:fields:start -->` and `<!-- crud:fields:end -->` is owned by the generator. Edit outside these markers.
