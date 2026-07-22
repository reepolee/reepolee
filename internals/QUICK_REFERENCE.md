# Reepolee Quick Reference

Fast lookup for common tasks and patterns.

## Common Commands

### CRUD Generation

```bash
# Interactive UI (recommended)
bun run reeman

# Command line
bun generator/resource.ts <table>                    # Full pipeline
bun generator/resource.ts <table> schema             # Schema only
bun generator/resource.ts <table> crud               # CRUD only
bun generator/resource.ts <table> --pagination cursor   # Custom pagination
bun generator/resource.ts <table> --refresh-fields   # Update after DDL changes
```

### Removing Routes

```bash
# Interactive UI
bun run reeman
→ Remove route

# Command line
bun generator/reeman/remove_route.ts <route_path>
```

### Testing

```bash
bun run dev              # Dev server with hot reload
bun run test             # Run all tests
bun run test:coverage    # With coverage report
```

---

## File Structure for CRUD

For each generated CRUD route, you get:

```
routes/users/
├-- schema/
│   ├-- table.ts              # Hand-editable field config (once per table)
│   └-- table.generated.ts    # Auto-generated from DB (regenerated)
├-- form.ree                   # Create/Edit form template (regenerated, markers preserved)
├-- index.ree                  # List/grid view template (regenerated, markers preserved)
├-- index.ts                   # Route handler (generated once, never regenerated)
├-- sql.ts                     # SQL queries (regenerated)
├-- sql.custom.ts              # Custom SQL (user-created, optional)
└-- sql_view.ts                # View-based queries (if view exists)
```

---

## Customization Cheat Sheet

### Safe to Customize (Preserved)

| File | Zone | Safe? | How |
|------|------|-------|-----|
| **form.ree** | Inside `<!-- crud:fields:start/end -->` | ✅ | Edit HTML, add CSS, add event listeners |
| **index.ree** | Inside `<!-- crud:fields:*:start/end -->` | ✅ | Edit headers, cells, add styling |
| **index.ts** | Anywhere (never regenerated) | ✅ | Add business logic, validation, side effects |
| **sql.custom.ts** | Entire file | ✅ | Add custom queries (separate file) |
| **table.ts** | Entire file | ✅ | Edit config, add custom attributes |

### Unsafe to Customize (Lost on Regeneration)

| File | Zone | Safe? | Solution |
|------|------|-------|----------|
| **form.ree** | Outside markers | ❌ | Move to inside markers or sql.custom.ts |
| **index.ree** | Outside markers | ❌ | Move to inside markers |
| **sql.ts** | Anywhere | ❌ | Use sql.custom.ts instead |
| **table.generated.ts** | Anywhere | ❌ | Edit table.ts instead |
| **Markers** | Delete/move markers | ❌ | Never delete markers |

---

## Database Schema Changes

### Adding a Column

```bash
# 1. Add to database
ALTER TABLE users ADD COLUMN age INT;

# 2. Update view (if exists)
ALTER VIEW v_users AS SELECT ... , age FROM users;

# 3. Regenerate
bun generator/resource.ts users --refresh-fields

# Result: age appears in form and list
```

### Removing a Column

```bash
# 1. Remove from database
ALTER TABLE users DROP COLUMN age;

# 2. Update view (if exists)
ALTER VIEW v_users AS SELECT ... FROM users;  # Remove age

# 3. Regenerate
bun generator/resource.ts users --refresh-fields

# Result: age removed from form and list
```

### Renaming a Column

```bash
# 1. Rename in database
ALTER TABLE users RENAME COLUMN age TO user_age;

# 2. Update view
ALTER VIEW v_users AS SELECT ... , user_age FROM users;

# 3. Regenerate
bun generator/resource.ts users --refresh-fields

# 4. Update index.ts if it references old column name
```

### Major Schema Restructure

```bash
# 1. Stash customizations
git stash

# 2. Remove the existing route
bun run reeman → Remove route → users

# 3. Regenerate completely
bun run reeman → Generate CRUD → users

# 4. Restore customizations
git stash pop  # May require manual merge

# 5. Test thoroughly
bun run dev
```

---

## Pagination Strategy

### Offset (Default)

```
Good for: < 100k rows
Generated with: bun generator/resource.ts <table>
Characteristics: Simple, slow at deep offsets
```

### Cursor

```
Good for: > 100k rows, any scroll depth
Generated with: bun generator/resource.ts <table> --pagination cursor
Characteristics: Fast, opaque cursors: [id, sort_value]
```

### Streaming

```
Good for: Heavy data fetching
Set in schema: export const render_strategy = "stream";
Characteristics: Sends data as fetched, no pagination limit
```

### Switching Strategies

```bash
git stash
bun run reeman → Remove route → <table>
bun run reeman → Generate CRUD → <table> → cursor
git stash pop
bun run dev
# Test, commit
```

---

## View Configuration

### Create a View for List Display

```sql
-- Table with hidden/internal columns
CREATE TABLE users (
  id INT PRIMARY KEY,
  email VARCHAR(255),
  password_hash VARCHAR(255),  -- Hidden
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  created_at TIMESTAMP,        -- Hidden
  updated_at TIMESTAMP         -- Hidden
);

-- View for list display
CREATE VIEW v_users AS
SELECT 
  id,
  email,
  CONCAT(first_name, ' ', last_name) AS full_name,
  DATE(created_at) AS joined_date
FROM users;
```

**Result:**
- `fields` = all table columns (for form)
- `v_fields` = view columns (for list)

---

## Foreign Key Patterns

### Hard FK (Database Constraint)

```sql
CREATE TABLE order_items (
  order_id INT NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id)
);
```

**Generator:** Respects constraint, uses it as-is.

### Soft FK (Code-Level Detection)

```sql
CREATE TABLE order_items (
  order_id INT  -- No constraint, but name matches pattern
);
```

**Generator:** Detects via naming convention, creates dropdown options.

### Soft Delete (Planned)

```typescript
// Future:
export const enable_soft_delete = true;
export const soft_delete_column = "deleted_at";
```

---

## Nested CRUD

### Generate Parent and Child

```bash
# 1. Generate parent
bun generator/resource.ts orders

# 2. Generate child with parent reference
bun generator/resource.ts order_items --parent orders

# Result:
#   - Parent form shows nested child list/form
#   - Child can't be created without parent
#   - Parent deletion leaves children orphaned (cascade not yet auto-implemented)
```

### Current Limitations

- ❌ No cascading deletes (yet)
- ❌ No pagination on children (they load in full)
- ❌ No moving children to different parent (yet)
- ❌ No streaming for nested children (yet)

---

## Performance Tuning

### For Offset Pagination

```sql
-- Verify indexes on primary key and sorted columns
CREATE INDEX idx_users_id ON users(id);
CREATE INDEX idx_users_created_at ON users(created_at);
```

### For Cursor Pagination

```sql
-- Critical: index on cursor column (usually id)
CREATE INDEX idx_users_id ON users(id);

-- Optional: indexes on filtered columns
CREATE INDEX idx_users_status ON users(status);
CREATE INDEX idx_users_created_at ON users(created_at);
```

### For Full-Text Search

```sql
-- MySQL
CREATE FULLTEXT INDEX idx_users_search ON users(first_name, last_name, email);

-- SQLite (FTS5)
CREATE VIRTUAL TABLE users_fts USING fts5(first_name, last_name, email);
```

### Benchmarking Queries

```sql
-- Compare pagination strategies
-- Offset at deep position
SELECT * FROM orders LIMIT 20 OFFSET 50000;  -- 500-2000ms

-- Cursor at same position
SELECT * FROM orders WHERE id > 50000 LIMIT 20;  -- 10-50ms

-- With WHERE filter
SELECT * FROM orders WHERE status = 'pending' AND id > 50000 LIMIT 20;  -- Still fast
```

---

## Common Patterns

### Custom Validation in Form

```html
<!-- crud:fields:start -->
  <input name="email" id="email" />
  
  <script>
    document.getElementById('email').addEventListener('blur', async (e) => {
      const exists = await fetch(`/api/check-email?email=${e.target.value}`)
        .then(r => r.json())
        .then(d => d.exists);
      
      if (exists) {
        e.target.classList.add('is-invalid');
      }
    });
  </script>
<!-- crud:fields:end -->
```

### Custom Event Listener

```html
<!-- crud:fields:start -->
  <input name="price" id="price" />
  
  <script>
    document.getElementById('price').addEventListener('input', (e) => {
      const value = parseFloat(e.target.value);
      if (value < 0) {
        e.target.value = 0;
      }
    });
  </script>
<!-- crud:fields:end -->
```

### Custom Route Logic

```typescript
// routes/users/index.ts
export async function post(req: Request, ctx: RequestContext) {
  const body = await req.json();
  
  // Custom validation
  if (body.email.includes('+')) {
    return new Response(
      JSON.stringify({ error: "Email aliases not allowed" }),
      { status: 400 }
    );
  }
  
  // Custom side effect
  await send_welcome_email(body.email);
  
  // Standard create
  const user = await sql.create_record(body);
  return render(req, "index.ree", { created: user });
}
```

### Custom SQL Query

```typescript
// routes/users/sql.custom.ts
export async function get_active_users() {
  return await db`SELECT * FROM users WHERE status = 'active'`;
}

// routes/users/index.ts
import * as sql_custom from "./sql.custom.js";

export async function get(req: Request, ctx: RequestContext) {
  const users = await sql_custom.get_active_users();
  return render(req, "index.ree", { users });
}
```

---

## Troubleshooting Quick Fixes

| Problem | Quick Fix |
|---------|-----------|
| Column not appearing in form | Run `--refresh-fields` |
| Marker not found error | Check markers exist, don't delete `<!-- crud:fields:start/end -->` |
| FK dropdown empty | Verify FK table exists and has data |
| Slow pagination | Check table size; if > 100k rows, switch to cursor |
| Customizations lost | Ensure they're inside markers |
| Can't edit after regeneration | Check if edits are outside markers |
| View doesn't have new column | Update view SQL, then regenerate |
| Merge conflict in CRUD files | Accept regenerated version, re-apply customizations |

---

## File Sizes & Performance

| Item | Typical Size | Notes |
|------|--------------|-------|
| form.ree | 2-5 KB | Grows with fields |
| index.ree | 3-8 KB | Grows with columns in view |
| index.ts | 15-30 KB | Grows with custom logic |
| sql.ts | 8-15 KB | Grows with FK count and features |
| Total per CRUD | ~50 KB | Minimal overhead |

---

## Documentation Reference

- **Full Architecture Guide:** [ARCHITECTURE.md](./ARCHITECTURE.md)
- **Development Workflows:** [DEVELOPMENT_GUIDE.md](./DEVELOPMENT_GUIDE.md)
- **Generator API:** See codebase `generator/` directory
