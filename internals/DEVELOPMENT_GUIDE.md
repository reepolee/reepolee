# Reepolee Developer Guide

Practical workflows and best practices for working with generated CRUD code.

## Table of Contents

1. [Initial CRUD Generation](#initial-crud-generation)
2. [Customizing Generated Code](#customizing-generated-code)
3. [Handling Schema Changes](#handling-schema-changes)
4. [Performance Optimization](#performance-optimization)
5. [Troubleshooting](#troubleshooting)

---

## Initial CRUD Generation

### Step 1: Prepare Your Database

Ensure your table is fully defined with proper types and constraints:

```sql
CREATE TABLE users (
  id INT PRIMARY KEY AUTO_INCREMENT,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Add indexes for foreign key columns and common filters
CREATE INDEX idx_users_email ON users(email);
```

### Step 2 (Optional): Create a View

If you want to display computed or derived columns in lists:

```sql
CREATE VIEW v_users AS
SELECT 
  u.id,
  u.email,
  CONCAT(u.first_name, ' ', u.last_name) AS full_name,
  DATE(u.created_at) AS joined_date
FROM users u;
```

### Step 3: Generate Schema

```bash
bun generator/resource.ts users schema
```

This creates `routes/users/schema/` with introspected field definitions.

### Step 4: Generate CRUD

```bash
# Option A: Interactive reeman (recommended)
bun run reeman
→ Generate CRUD
→ Select table: users
→ Pagination strategy: offset (default)

# Option B: Command line
bun generator/resource.ts users --pagination offset
```

### Step 5: Verify Generated Files

Check that generation created:
- `routes/users/form.ree` (Create/Edit form)
- `routes/users/index.ree` (List/grid view)
- `routes/users/index.ts` (Route handler)
- `routes/users/sql.ts` (SQL queries)

### Step 6: Update Routes Registry

Routes should be auto-registered. Verify in `routes/routes.ts`:

```typescript
export const users_crud = {
  get: route('/users', users.get),
  post: route('/users', users.post),
  delete: route('/users/:id', users.delete),
};
```

### Step 7: Test in Development

```bash
bun run dev

# Navigate to http://localhost:2338/users
# Test: Create, Edit, Delete operations
```

---

## Customizing Generated Code

### Safe Customizations (Preserved on Regeneration)

#### 1. Form Field HTML (form.ree)

```html
<form method="POST">
  <!-- crud:fields:start -->
    <div class="form-group">
      <label for="email">Email Address</label>
      <input 
        id="email" 
        name="email" 
        type="email" 
        required 
        class="form-control email-input"
      />
      <small class="help-text">We'll never share your email.</small>
    </div>
    
    <div class="form-group">
      <label for="first_name">First Name</label>
      <input 
        id="first_name" 
        name="first_name" 
        type="text"
        class="form-control"
      />
    </div>

    <script>
      // Custom validation
      const emailInput = document.querySelector('input[name="email"]');
      emailInput.addEventListener('blur', async (e) => {
        const exists = await checkEmailExists(e.target.value);
        if (exists) {
          e.target.classList.add('is-invalid');
        }
      });
    </script>

    <style>
      .email-input { border: 2px solid #007bff; }
      .form-group { margin-bottom: 1.5rem; }
    </style>
  <!-- crud:fields:end -->

  <button type="submit" class="btn btn-primary">Save</button>
</form>
```

Everything inside `<!-- crud:fields:start/end -->` is preserved on regeneration.

#### 2. List Grid Headers (index.ree)

```html
<table class="table">
  <thead>
    <!-- crud:fields:headers -->
      <th>
        Email <span class="required">*</span>
      </th>
      <th>Full Name</th>
      <th class="text-right">Joined Date</th>
    <!-- crud:fields:headers -->
  </thead>
  <tbody>
    <!-- crud:fields:cells -->
      <td>{{email}}</td>
      <td>{{full_name}}</td>
      <td class="text-right">{{joined_date}}</td>
    <!-- crud:fields:cells -->
  </tbody>
</table>
```

#### 3. Route Handler Extensions (index.ts)

Once generated, `index.ts` is never regenerated. Extend it directly:

```typescript
// routes/users/index.ts
import { render } from "$lib/render";
import * as sql from "./sql.js";

export async function get(req: Request, ctx: RequestContext) {
  // Standard list handler
  const { search, page } = Object.fromEntries(new URL(req.url).searchParams);
  const { records, total } = await sql.search_records(search, null, null, false, 20);
  
  return render(req, "index.ree", {
    users: records,
    total_count: total,
  });
}

export async function post(req: Request, ctx: RequestContext) {
  const body = await req.json();
  
  // Custom: validate uniqueness
  const existing = await sql.get_record_by_email(body.email);
  if (existing) {
    return new Response(
      JSON.stringify({ error: "Email already exists" }),
      { status: 400 }
    );
  }
  
  // Custom: hash password
  const hashed = await Bun.password.hash(body.password_hash);
  
  // Custom: send welcome email
  await send_welcome_email(body.email, body.first_name);
  
  // Standard: create record
  const user = await sql.create_record({
    ...body,
    password_hash: hashed,
  });
  
  return render(req, "index.ree", { created: user });
}

export async function delete(req: Request, ctx: RequestContext) {
  const { id } = ctx.params;
  
  // Custom: audit log
  await log_audit_event("user_deleted", { user_id: id });
  
  // Standard: delete
  await sql.delete_record(id);
  
  return new Response(null, { status: 204 });
}
```

#### 4. Custom SQL Queries (sql.custom.ts)

Create a separate file for custom queries:

```typescript
// routes/users/sql.custom.ts
import { db } from "$config/db";

export async function get_users_by_status(status: string) {
  try {
    return await timed_query("users", "get_users_by_status", async () => {
      return await db`SELECT * FROM users WHERE status = ${status}`;
    });
  } catch (error) {
    console.error("Error fetching users by status:", error);
    return [];
  }
}

export async function search_users_by_email_domain(domain: string) {
  try {
    return await timed_query("users", "search_users_by_domain", async () => {
      return await db`SELECT * FROM users WHERE email LIKE ${'%@' + domain}`;
    });
  } catch (error) {
    console.error("Error searching users by domain:", error);
    return [];
  }
}
```

Then use in `index.ts`:

```typescript
import * as sql from "./sql.js";
import * as sql_custom from "./sql.custom.js";

export async function get(req: Request, ctx: RequestContext) {
  const { domain } = Object.fromEntries(new URL(req.url).searchParams);
  
  if (domain) {
    // Use custom query
    const users = await sql_custom.search_users_by_email_domain(domain);
    return render(req, "index.ree", { users });
  }
  
  // Use standard query
  const { records } = await sql.search_records();
  return render(req, "index.ree", { users: records });
}
```

### Unsafe Customizations (Lost on Regeneration)

❌ **Outside markers:**
```html
<!-- This will be lost -->
<div class="custom-header">
  My custom section
</div>
<!-- crud:fields:start -->
  ...
<!-- crud:fields:end -->
```

❌ **Modifying sql.ts directly:**
```typescript
// This will be lost on regeneration
export async function custom_query() { ... }
```

❌ **Deleting markers:**
```html
<!-- DON'T delete these comments -->
<!-- crud:fields:start -->
<!-- crud:fields:end -->
```

---

## Handling Schema Changes

### Adding a Column

**Workflow:**
```bash
# 1. Add column to database
ALTER TABLE users ADD COLUMN phone_number VARCHAR(20);

# 2. Update view (if using one)
ALTER VIEW v_users AS
SELECT u.id, u.email, CONCAT(u.first_name, ' ', u.last_name) AS full_name,
       DATE(u.created_at) AS joined_date, u.phone_number
FROM users u;

# 3. Refresh schema
bun generator/resource.ts users --refresh-fields

# 4. Result: phone_number now appears in form and list
```

### Removing a Column

**Workflow:**
```bash
# 1. Remove column from database
ALTER TABLE users DROP COLUMN phone_number;

# 2. Update view (if using one)
ALTER VIEW v_users AS
SELECT u.id, u.email, CONCAT(u.first_name, ' ', u.last_name) AS full_name,
       DATE(u.created_at) AS joined_date
FROM users u;

# 3. Refresh schema
bun generator/resource.ts users --refresh-fields

# 4. Result: phone_number removed from form and list
```

### Renaming a Column

**Workflow:**
```bash
# 1. Rename in database
ALTER TABLE users RENAME COLUMN phone_number TO contact_number;

# 2. Update view
ALTER VIEW v_users AS
... contact_number ...

# 3. Refresh schema
bun generator/resource.ts users --refresh-fields

# 4. Manually update index.ts if it references the old column
```

### Changing Column Type

**Workflow:**
```bash
# 1. Change type
ALTER TABLE users MODIFY COLUMN age INT;

# 2. Refresh schema
bun generator/resource.ts users --refresh-fields

# 3. Test form validation (Zod schema may change)
bun run dev
```

### Heavy Schema Changes (Multiple Columns)

If you're making extensive changes, you may want to regenerate the entire CRUD:

```bash
# 1. Stash customizations
git stash

# 2. Delete the existing CRUD module
bun run reeman → Remove route → users

# 3. Regenerate from scratch
bun run reeman → Generate CRUD → users

# 4. Restore customizations
git stash pop  # Requires manual merge

# 5. Test thoroughly
bun run dev
```

---

## Performance Optimization

### When to Switch from Offset to Cursor Pagination

**Signs you need to switch:**
- Table has > 100k rows
- Users frequently scroll deep into results
- Page load times slow down at page 100+

### Switching Pagination Strategies

```bash
# 1. Stash customizations
git stash

# 2. Remove the existing route
bun run reeman
→ Remove route
→ Select: users

# 3. Regenerate with cursor
bun run reeman
→ Generate CRUD
→ Select table: users
→ Pagination strategy: cursor

# 4. Restore customizations
git stash pop

# 5. Test and commit
bun run dev
# Verify pagination works at scale
git add -A && git commit -m "Switch users to cursor pagination"
```

### Creating Indexes for Pagination

After switching to cursor pagination, create indexes:

```sql
-- Index for cursor pagination (WHERE id > ${cursor})
CREATE INDEX idx_users_id ON users(id);

-- Indexes for common filters
CREATE INDEX idx_users_created_at ON users(created_at);
CREATE INDEX idx_users_email ON users(email);

-- Full-text search indexes
CREATE FULLTEXT INDEX idx_users_search ON users(first_name, last_name, email);
```

### Monitoring Query Performance

Check slow queries in MySQL:
```sql
-- Enable slow query log
SET GLOBAL slow_query_log = 'ON';
SET GLOBAL long_query_time = 0.5;

-- View slow queries
SHOW VARIABLES LIKE 'slow_query_log_file';
```

Compare offset vs cursor performance:
```sql
-- Offset query (slow at deep offsets)
SELECT * FROM users LIMIT 20 OFFSET 50000;  -- 500-2000ms

-- Cursor query (fast at any depth)
SELECT * FROM users WHERE id > 50000 LIMIT 20;  -- 10-50ms
```

### Using Streaming for Heavy Operations

Configure streaming for lists with many rows:

```typescript
// routes/users/schema/table.ts
export const render_strategy: "stream" | "load" = "stream";
```

This sends data to the client as it's fetched, reducing perceived load time.

---

## Troubleshooting

### Marker Not Found Error

**Problem:** `Error: Marker "crud:fields:start" not found in form.ree`

**Solution:**
```bash
# Option 1: Restore the marker manually
# Edit form.ree and add markers back:
<!-- crud:fields:start -->
  <!-- Your fields here -->
<!-- crud:fields:end -->

# Option 2: Regenerate completely
bun generator/crud.ts users --force
# This will overwrite all customizations, so stash first if needed
```

### Schema Doesn't Update After Database Change

**Problem:** You added a column but it doesn't appear in the form.

**Solution:**
```bash
# Run refresh-fields
bun generator/resource.ts users --refresh-fields

# Or regenerate schema
bun generator/resource.ts users schema
bun generator/resource.ts users crud --force
```

### Foreign Key Dropdown Not Showing Options

**Problem:** Create/Edit form doesn't show FK dropdown for orders.

**Solution:**
1. Verify the foreign table exists and has data
2. Check that the FK column is properly named (e.g., `order_id`)
3. Regenerate schema to re-detect FK:
   ```bash
   bun generator/resource.ts orders schema
   bun generator/resource.ts orders crud --force
   ```

### Slow List View Performance

**Problem:** List takes 10+ seconds to load.

**Solutions:**
1. **Check row count:** `SELECT COUNT(*) FROM users;`
   - If > 100k, switch to cursor pagination (see section above)
2. **Check indexes:** `SHOW INDEX FROM users;`
   - Add missing indexes for filtered/sorted columns
3. **Check query:** Look at generated `sql.ts` in `search_records()`
   - Optimize JOINs, remove unnecessary columns

### Merge Conflicts in Generated Files

**Problem:** Git merge conflict in form.ree after regenerating in another branch.

**Solution:**
```bash
# View the conflict
git diff form.ree

# Usually safe to accept the regenerated version
git checkout --theirs form.ree

# Re-apply customizations manually if needed
# (They should be inside markers and preserved)

git add form.ree
git commit -m "Resolve CRUD merge conflict"
```

### Custom Validation Not Working

**Problem:** `--refresh-fields` lost your custom validation event listeners.

**Cause:** The content *between* the CRUD markers is generator-owned. On refresh it is regenerated and replaced - anything you add there (like a standalone `<script>`) is overwritten. Markers preserve **outside** content, not inside content.

**Solution:** Put custom code *outside* the markers:

```html
<!-- crud:fields:start -->
  <input name="email" />
<!-- crud:fields:end -->

<script>
  // Outside the managed section → preserved across refresh
  document.querySelector('input[name="email"]').addEventListener('change', validate);
</script>
```

If still lost, double-check:
1. Markers exist and aren't deleted
2. Your custom code is **outside** `<!-- crud:fields:start -->` … `<!-- crud:fields:end -->`
3. No nested generators running (they overwrite, then you refresh, losing changes)

> **Note:** Within the managed section, `--refresh-fields` does a *smart merge*: per-field edits inside an existing `<field-wrapper>` are preserved as long as the field's template type and element signature are unchanged. But this only protects field-wrapper blocks - never put standalone scripts or other custom markup between the markers.

---

## Best Practices

### ✅ Do

- Generate CRUD once, then customize
- Put customizations inside markers
- Use sql.custom.ts for custom queries
- Extend index.ts with business logic
- Commit generated files to git
- Run `--refresh-fields` when adding/removing columns
- Create indexes for FK and filtered columns
- Test pagination at scale before deploying

### ❌ Don't

- Edit sql.ts directly (it gets regenerated)
- Delete or move markers
- Modify table.generated.ts (always regenerated)
- Add custom code outside markers in form.ree/index.ree
- Ignore database schema errors (generator will fail loudly)
- Use offset pagination for tables > 1M rows
- Forget to create indexes for FK columns
