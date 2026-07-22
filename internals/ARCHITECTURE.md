# Reepolee Architecture Guide

This document explains the core architectural decisions in Reepolee, covering schema design, data integrity, code generation lifecycle, and pagination strategies.

## Quick Navigation

- [Schema Detection & Field Visibility](#schema-detection--field-visibility)
- [Data Integrity & Foreign Keys](#data-integrity--foreign-keys)
- [Generated Code Lifecycle](#generated-code-lifecycle)
- [Pagination Strategies](#pagination-strategies)

---

## Schema Detection & Field Visibility

### The Dual-Field System

Reepolee uses a **two-field architecture** to separate data editing from data display:

- **`fields`** - All columns from the actual database table (used for form validation, Create/Edit operations)
- **`v_fields`** - Columns from an optional database view (used for list/grid display only)

This allows:
- Forms to work with real table data (validation, updates)
- Lists to show computed/derived columns without touching the table
- Cleaner list UX (hide internal fields, show derived fields)

### View Detection & Naming

**View naming convention:** Must use `v_` prefix (e.g., `v_users`, `v_orders`).

- If a `v_` prefixed view exists, the generator extracts its columns as `v_fields`
- If no view exists, `v_fields` is set to `null`, and the system falls back to using `fields` for both editing and listing
- If multiple views exist, only the `v_` prefixed one is recognized

### Field Filtering Rules

**`IGNORE_INDEX_FIELDS`** (in `config/db_structure.ts`):
- Hardcoded system-level conventions (e.g., `created_at`, `updated_at`, `id`) that never appear in list grids
- Not per-project configurable (would require modifying config directly)

**FK `_id` field hiding:**
- Automatically hidden if a corresponding `_name` field exists in the view (e.g., `author_id` hidden when `author_name` is present)
- Can be restored later by editing `columns` in `table.ts`

**Visibility precedence** (highest to lowest):
1. `omit_index: true` in schema → don't show in grid
2. View column exists → show in grid
3. Table column exists → show in grid

### Real-World Example

**Setup:**
```sql
CREATE TABLE users (
  id INT PRIMARY KEY,
  email VARCHAR(255),
  password_hash VARCHAR(255),
  created_at TIMESTAMP,
  updated_at TIMESTAMP
);

CREATE VIEW v_users AS
SELECT 
  id, 
  email, 
  CONCAT(first_name, ' ', last_name) AS full_name,
  DATE(created_at) AS joined_date
FROM users;
```

**Generated Schema:**
```typescript
export const fields = {
  id, email, password_hash, created_at, updated_at
};

export const v_fields = {
  id, email, full_name, joined_date
};

export const columns = {
  "id": { width: "80px" },
  "email": { width: "300px" },
  "full_name": { width: "300px" },
  "joined_date": { width: "120px" }
  // password_hash NOT shown (not in v_fields)
};
```

**Result:**
- Form shows all 5 fields (user can edit email, see timestamps)
- List shows only 4 fields (password_hash hidden, derived fields visible)

### Adding New Columns

**Workflow:**
```bash
# 1. Add column via migration
ALTER TABLE users ADD COLUMN phone_number VARCHAR(20);

# 2. Update view (if using one)
ALTER VIEW v_users AS
SELECT id, email, CONCAT(first_name, ' ', last_name) AS full_name, 
       DATE(created_at) AS joined_date, phone_number
FROM users;

# 3. Regenerate schema
bun generator/resource.ts users --pagination offset

# 4. Result: phone_number now appears in both form and list
```

---

## Data Integrity & Foreign Keys

### The Hybrid FK Approach

Reepolee respects existing database FK constraints but enhances with code-level detection if they don't exist.

**Hard FKs (database constraints) - RESPECTED:**
```sql
CREATE TABLE order_items (
  order_id INT NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id)
);
```
The generator recognizes these and works with them as-is.

**Soft FKs (code-level, by naming convention) - ENHANCED IF MISSING:**
```sql
CREATE TABLE order_items (
  order_id INT  -- No FK constraint, but name matches pattern
);
```
If no database constraint exists, the generator detects that `order_id` maps to `orders.id` via naming convention.

### Why Hybrid?

**Respect existing constraints** because:
- If your team uses hard FKs, the generator won't interfere
- Your schema investment is preserved
- Database integrity is enforced at the database level

**Enhance with soft detection** because:
- Not every schema has hard FKs defined (and that's okay)
- Changing column types fails when hard constraints are involved
- Soft FKs give flexibility to evolve schema without DB constraint friction

### Generator FK Strategy

1. **Detect existing hard FKs** via database introspection
2. **If hard FKs exist**, respect them and use them as-is
3. **If no hard FKs exist**, detect via naming conventions (e.g., `user_id` → `users.id`)
4. Create indexes on FK columns (for performance)
5. Maintain relationships in code (validation, dropdown queries)
6. Let users manage hard constraints via migrations (optional)

### Cascading Deletes

**Current behavior:**
- Generator does NOT create migration files with `ON DELETE CASCADE`
- FK constraints are user responsibility via separate migrations
- Database must be in fully working order before generator runs

**Parent deletion:**
- Parent record is deleted
- Child records remain in database (orphaned)
- If child has `NOT NULL fk_parent_id`, database rejects parent delete (catches bugs early)

**Recommended pattern: Nullable FK + no cascade + app-level cascade when needed**

```typescript
// 1. Make FK columns NULLABLE
CREATE TABLE order_items (
  order_id INT,  -- Nullable
  FOREIGN KEY (order_id) REFERENCES orders(id)
  -- NO ON DELETE CASCADE
);

// 2. If you want cascade, add it explicitly in code
export async function delete_order_with_items(order_id: number) {
  await db`DELETE FROM order_items WHERE order_id = ${order_id}`;
  await db`DELETE FROM orders WHERE id = ${order_id}`;
}
```

This gives you:
- ✅ Freedom to evolve schema (no hard constraint friction)
- ✅ Clean DB rejection if constraint is violated (catches bugs)
- ✅ Control over cascading logic (decide per-operation)
- ✅ Ability to log, audit, or condition cascade behavior

### Soft Deletes (Planned)

Not yet implemented, but planned for the future. When available:
- Per-table configuration: `enable_soft_delete: true`
- Soft delete will mark records as deleted instead of removing them
- Routes will automatically filter out soft-deleted records

---

## Generated Code Lifecycle

### Core Philosophy: Generate Once, Customize Carefully

**Generators are primarily used once.** After initial generation, customize within protected markers. Regenerate only when database schema changes significantly.

Generated files are **committed to git** and treated as part of your codebase, with clear boundaries around what can be safely edited.

### File Update Strategy

| File | Regenerated? | Preserved? | How |
|------|--------------|-----------|-----|
| **form.ree** | Yes | Marker content preserved | Inside `<!-- crud:fields:start/end -->` |
| **index.ree** | Yes | Marker content preserved | Inside `<!-- crud:fields:*:start/end -->` |
| **index.ts** | No | All customizations preserved | Never regenerated after initial creation |
| **sql.ts** | Yes (full file) | None | Entire file is replaced; use sql.custom.ts for extensions |
| **table.generated.ts** | Yes (full file) | None | Always regenerated from DB introspection |
| **table.ts** | No (first run only) | All customizations preserved | Create once, edit forever |

### Protected Zones (Markers)

**Safe to customize inside markers:**
```html
<!-- crud:fields:start -->
  <!-- Users can edit HTML, CSS, event handlers here -->
  <input name="email" class="email-input" />
  <script>
    // Custom validation
    document.querySelector('input[name="email"]').addEventListener('blur', validate);
  </script>
  <style>
    input[name="email"] { border: 2px solid blue; }
  </style>
  <div class="admin-only" style="display: ${user.is_admin ? 'block' : 'none'}">
    Admin field
  </div>
<!-- crud:fields:end -->
```

Everything inside markers is preserved on regeneration.

**Regenerated on each update:**
```html
<!-- Edits here WILL be wiped on regeneration -->
<div class="custom-section">
  User edits lost
</div>
```

### Route Handler (`index.ts`) Lifecycle

Once generated, the route handler is **never regenerated**. Users extend it directly without touching templates.

**Workflow:**
1. Generator creates `routes/users/index.ts` with GET, POST, DELETE handlers
2. User adds custom logic directly to `index.ts` (validation, side effects, etc.)
3. User never re-runs generator for this file

**If heavy DB changes occur:**
```bash
# Stash user changes
git stash

# Regenerate
bun generator/crud.ts users --force

# Restore custom logic
git stash pop  # Requires manual merge if conflicts
```

### SQL Query Customization

Generated `sql.ts` is regenerated entirely. Best practice: keep custom queries in a separate file.

```typescript
// routes/users/sql.ts (auto-generated, don't edit)
// Standard CRUD queries only

// routes/users/sql.custom.ts (user-owned, never regenerated)
export async function get_users_by_status(status: string) {
  return await db`SELECT * FROM users WHERE status = ${status}`;
}

// routes/users/index.ts
import * as sql from './sql.js';
import * as sql_custom from './sql.custom.js';

const all_users = await sql.get_all_records();
const active_users = await sql_custom.get_users_by_status('active');
```

This way:
- ✅ `sql.ts` can be regenerated freely
- ✅ Custom queries are preserved in `sql.custom.ts`
- ✅ No manual stashing needed

### Nested CRUD Injection

When nested CRUD is added to an existing parent, markers are injected into parent `form.ree` and `index.ts`.

```html
<!-- Parent form.ree -->
<!-- crud:children:start -->
  <!-- Nested child section injected here -->
  <div class="nested-items">
    <!-- Child form and list -->
  </div>
<!-- crud:children:end -->
```

Nested CRUD injection works reliably when:
- Parent and child are generated together (all in one run)
- Markers are present in expected positions
- Parent structure wasn't dramatically restructured

### Regeneration Frequency

**Typical workflow:**
```bash
# Initial generation
bun generator/resource.ts users

# Customize within markers (add validation, styling, event handlers)
# Extend index.ts (add business logic)
# Add sql.custom.ts (custom queries)

# Months later: database schema changes significantly
# Add columns, rename fields, restructure table

# Regenerate when needed
bun generator/resource.ts users --refresh-fields
# New columns appear in form and list, customizations preserved
```

### Version Control & Merge Conflicts

**Files are committed.** Conflicts are rare because regeneration is infrequent.

When conflicts occur:
- Accept the new version from regeneration
- Manually re-apply customizations from the conflicting branch
- Commit the resolved version

Markers help resolve conflicts automatically because they act as clear boundaries.

### Adding New Columns

**Workflow:**
```bash
# 1. Database change
ALTER TABLE users ADD COLUMN phone_number VARCHAR(20);

# 2. Refresh schema metadata
bun generator/resource.ts users --refresh-fields

# 3. Result:
#    - form.ree: phone_number added, customizations preserved
#    - index.ree: phone_number added, customizations preserved
#    - index.ts: untouched
#    - sql.ts: regenerated with new field
```

---

## Pagination Strategies

### Core Philosophy: Offset by Default, Cursor When Needed

**Offset pagination is the default** because most tables are small. When tables grow large or performance becomes an issue, switch to cursor pagination via the reeman-a simple operation.

### Strategy Overview

**Offset Pagination (default):**
- Simple, easy to understand
- Good for small tables (< 100k rows)
- Slow at deep offsets (page 1000+)

**Cursor Pagination:**
- More complex (cursor encoding/decoding)
- Fast at any scroll depth
- Requires sortable primary key
- 50-100x faster than offset at scale

**Streaming:**
- Sends rows as they're fetched (no pagination)
- Good for heavy data fetching operations
- Works with pagination

### Decision Matrix

| Scenario | Recommended | Reason |
|----------|-------------|--------|
| **< 100k rows, typical usage** | Offset | Simpler, fast enough |
| **100k - 1M rows, deep scrolling** | Cursor | Better performance at scale |
| **> 1M rows** | Cursor | Mandatory for acceptable performance |
| **Heavy data fetching** | Streaming | Start showing results immediately |
| **Real-time updates expected** | Cursor | Stable under mutations |
| **External data consumers** | Views | Single source of truth |
| **Nested CRUD (children)** | No pagination | Load all children inline |
| **Nested CRUD (parent)** | Offset or Cursor | Parent-level strategy only |

### Cursor Implementation

Cursors are encoded as `JSON.stringify([id, sort_value])`, making them transparent and inspectable by clients.

```
Cursor: [50, "2024-01-15"]
// Can be decoded and inspected to understand pagination state
```

### Performance Characteristics

**Offset:**
- Time: O(n) where n = offset value
- Space: O(limit)
- Best for: Small tables, shallow scrolling
- Worst for: Large offsets (page 1000+)

**Cursor:**
- Time: O(log n) - index lookup
- Space: O(limit)
- Best for: Large tables, any scroll depth
- Worst for: Jumping to arbitrary positions

### Cursor Stability

Cursors are stable under mutations:
```
Page 1: id > 0 ORDER BY id ASC → [1, 2, 3, ..., 20]
Cursor: 20

New record inserted: id=25

Page 2: id > 20 ORDER BY id ASC → [21, 22, 23, ..., 40]
// Includes id=25, no duplicates or missed records
```

IDs are auto-increment (always growing), so new records don't interfere with existing pagination state.

### View-Based Pagination

Views serve as a **single source of truth** for:
1. External data consumption (Excel, Tableau, other departments)
2. Soft FK definition in DDL
3. Derived/computed columns for list display

Views with JOINs paginate efficiently because:
- Database optimizes the JOIN
- Pagination (LIMIT/WHERE) happens after JOIN
- Indexes on underlying tables are used effectively

### Nested CRUD Pagination

**Current behavior:**
- Only parent uses pagination
- Children are fetched in full (no pagination on children)
- If parent has 100 children, all 100 are loaded into memory

**Future enhancement:**
- Streaming parent header + streamed child records
- Parent header displays immediately
- Children stream in as they're fetched

### Index Optimization

Indexes are **not automatically created** by the generator. User/DBA responsibility via migrations.

**Recommended indexes for pagination:**
```sql
-- Cursor pagination queries benefit greatly from indexes
CREATE INDEX idx_orders_id ON orders(id);
CREATE INDEX idx_orders_created_at ON orders(created_at);

-- Full-text search indexes (MySQL FULLTEXT, SQLite FTS5)
CREATE FULLTEXT INDEX idx_orders_search ON orders(customer_name, order_notes);
```

### Migrating Between Strategies

**Low friction:** Delete and recreate route via reeman.

```bash
# Stash customizations
git stash

# Remove the existing route
bun run reeman → Remove route → orders

# Create with new strategy
bun run reeman → Generate CRUD → orders → pagination_strategy: cursor

# Restore customizations
git stash pop

# Total time: 15-30 minutes for typical CRUD
```

### Real-World Example: E-Commerce

**Scenario:** 500k orders, 5M order items (nested under orders). Offset pagination causing slow page loads at deep offsets.

**Solution:**
```
Before (offset at order #450,000):
  SELECT * FROM orders LIMIT 20 OFFSET 100000  -- 1000-2000ms

After (cursor at same position):
  SELECT * FROM orders WHERE id > ${last_id} LIMIT 20  -- 10-50ms

Improvement: 50-100x faster
```

**Implementation:**
1. Stash customizations
2. Switch to cursor via reeman
3. Restore customizations
4. Test and commit

---

## Summary

Reepolee's architecture balances **simplicity** with **flexibility**:

- **Schema**: Dual-field system (table fields + view fields) for clean separation of concerns
- **Data integrity**: Respects hard FK constraints, enhances with soft detection, shifts responsibility to code
- **Code generation**: Generate once, customize within markers, regenerate rarely
- **Pagination**: Start simple (offset), upgrade when needed (cursor), low migration friction

This design works for teams that value **code-level control**, **schema flexibility**, and **pragmatic performance optimization**.
