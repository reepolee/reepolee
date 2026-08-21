/** Prefix for internal/working/temp tables - these are excluded from all
 * table selection UIs, CRUD generation, and schema introspection.
 * Tables like `_temp_migration`, `_backup_data`, etc. use this prefix. */
export const INTERNAL_TABLE_PREFIX = "_" as const;

/**
 * Do not generate CRUD routes for the following tables
 */
export const IGNORE_TABLES = ["modules", "sessions", "email", "images", "files", "users", "translations", "db_tables", "db_routes"] as const satisfies readonly string[];

/**
 * Archive (soft delete) columns.
 * A table carrying `archived_at` is archivable: its generated `archive_record`
 * writes these two columns instead of issuing a DELETE, and every generated
 * read filters `archived_at IS NULL`. Both are maintenance fields - never user
 * input, never rendered in a form.
 * `archived_by_user_id` is a soft FK to `users.id` by naming convention only,
 * with no REFERENCES constraint, matching `files.uploaded_by_user_id`.
 */
export const ARCHIVE_TIMESTAMP_FIELD = "archived_at" as const;
export const ARCHIVE_USER_FIELD = "archived_by_user_id" as const;
export const ARCHIVE_DISPLAY_FIELD = "archived_by_user_display" as const;
export const ARCHIVE_FIELDS = [ARCHIVE_TIMESTAMP_FIELD, ARCHIVE_USER_FIELD] as const satisfies readonly string[];

/**
 * Tables that must never be archivable - a row here is genuinely removed.
 * `sessions` and `rate_limit_counters` are TTL-expired key/value stores; logout
 * and the rate-limit sweep have to delete for real. `jobs` and `queue_meta` are
 * owned by the queue's own lifecycle states. `db_tables` and `db_routes` are
 * metadata snapshots rebuilt by `DELETE FROM <table>` then reinsert on every
 * reeman page load, so archiving would accumulate garbage without bound.
 */
export const ARCHIVE_EXEMPT_TABLES = ["sessions", "rate_limit_counters", "jobs", "queue_meta", "db_tables", "db_routes"] as const satisfies readonly string[];

/**
 * Reserved `global_scopes.scope_key` values that select which archive state a
 * list shows. The route handler intercepts these and maps them to the
 * `archive_filter` parameter of `search_records`; their `where_clause` is never
 * used as SQL. The `__` prefix keeps them clear of admin-authored scope keys.
 * Anything else resolves to "live", so an ownership scope such as `my_files`
 * still means "my live files" and can never widen visibility.
 */
export const ARCHIVE_SCOPE_ARCHIVED = "__archived" as const;
export const ARCHIVE_SCOPE_ALL = "__all" as const;

/**
 * The live view is a reserved key too, so a seeded dropdown has an entry for
 * the normal state. Without it, picking "Archived" writes a 30-day
 * `scope_<table>` cookie and leaves no option that gets back to live rows.
 * It needs no branch in `resolve_archive_filter()` - every unrecognised key
 * already resolves to "live" - only recognition as a reserved key.
 */
export const ARCHIVE_SCOPE_LIVE = "__live" as const;

/**
 * The scope rows the CRUD generator offers to seed for an archivable table.
 * Their `where_clause` is empty by design: the route handler maps the key to
 * the `archive_filter` parameter instead of using it as SQL.
 */
export const ARCHIVE_SCOPE_SEEDS = [
	{ scope_key: ARCHIVE_SCOPE_LIVE, display_name: "Active", sort_order: 0, is_default: 1 },
	{ scope_key: ARCHIVE_SCOPE_ARCHIVED, display_name: "Archived", sort_order: 1, is_default: 0 },
	{ scope_key: ARCHIVE_SCOPE_ALL, display_name: "All", sort_order: 2, is_default: 0 },
] as const;

/**
 * Fields managed by DB, not user input
 * those will not be checked thru schema and written to db from user data
 */
export const MAINTENANCE_FIELDS = ["created_at", "updated_at", ARCHIVE_TIMESTAMP_FIELD, ARCHIVE_USER_FIELD] as const satisfies readonly string[];

/**
 * Date fields which end in, like "incorporated_on", "payment_due_by"
 * will be decoded and encoded correctly for display, form entry and database write
 */
export const DATE_SUFFIXES = ["_on", "_by"] as const satisfies readonly string[];

/**
 * Datetime fields which end in, like "created_at"
 * will be decoded and encoded correctly for display, form entry and database write
 */
export const DATETIME_SUFFIXES = ["_at"] as const satisfies readonly string[];

/**
 * Image fields which end in, like "portrait_image", "logo_image"
 * store an uploaded image path and render via <image-upload> in forms
 * and as a 100x100 thumbnail in grids (see lib/template_helpers.ts image_thumbnail)
 */
export const IMAGE_SUFFIXES = ["_image"] as const satisfies readonly string[];

/**
 * File fields which end in, like "contract_file", "invoice_file"
 * store an uploaded document path (PDF, DOCX, etc.) and render via <file-upload>
 * in forms and as a filename/size link in grids (see lib/template_helpers.ts file_link)
 */
export const FILE_SUFFIXES = ["_file"] as const satisfies readonly string[];

/**
 * Fields excluded from index/list schemas
 * those fields can be supplied by the SQL select but will not get a column on index table to be displayed by default
 */
export const IGNORE_INDEX_FIELDS = ["display", "option_display", "option_text", "search_text", "hashed_password", "previous_hashed_password", ARCHIVE_DISPLAY_FIELD] as const satisfies readonly string[];

/**
 * Fields excluded from sort options
 * these fields cannot be used for ordering results
 */
export const IGNORE_ORDER_FIELDS = ["option_display", "search_text", "hashed_password", "previous_hashed_password", ARCHIVE_DISPLAY_FIELD] as const satisfies readonly string[];

/**
 * Boolean fields
 * we treat them specially as they are integers and will always be present in form posts.
 * easier to manage and check for explicit user entry
 */
export const BOOLEAN_PREFIXES = ["is_", "has_", "can_"] as const satisfies readonly string[];

/**
 * Fields never eligible for per-locale content overrides, even when they
 * pass the type check below - they are identifiers/metadata, not translatable copy.
 */
export const LOCALIZATION_SYSTEM_FIELDS = ["id", "display", "search_text", "created_at", "updated_at", ARCHIVE_TIMESTAMP_FIELD, ARCHIVE_USER_FIELD, ARCHIVE_DISPLAY_FIELD] as const satisfies readonly string[];

/**
 * Field types reeman marks `localized: true` by default when
 * LOCALIZE_CONTENT=true - freeform text content, not structured
 * data like email/url/tel/number/date/checkbox.
 */
export const LOCALIZABLE_STRING_TYPES = ["text", "textarea", "markdown"] as const satisfies readonly string[];

export const MIN_PASSWORD_LENGTH = Bun.argv.includes("--dev") ? 1 : 8;

export const CURRENCY_FIELD = "decimal(18,2)" as const;
export const PERCENT_FIELD = "decimal(12,4)" as const;

// ---------------------------------------------------------------------------
// Column width defaults - initial grid column widths for generated CRUD index views.
// These can be overridden by the user in the generated schema/table.ts columns map.
// ---------------------------------------------------------------------------

// Default width for decimal/numeric columns.
export const COL_WIDTH_DECIMAL = "20ch";

// Default width for integer columns.
export const COL_WIDTH_INTEGER = "10ch";

// Default width for boolean/checkbox columns.
export const COL_WIDTH_BOOLEAN = "15ch";

// Default width for temporal columns (date, datetime, timestamp, time).
export const COL_WIDTH_TEMPORAL = "20ch";

// Default width for image thumbnail columns (100x100 preview + padding).
export const COL_WIDTH_IMAGE = "120px";

// Default width for file link columns (filename + size).
export const COL_WIDTH_FILE = "20ch";

// Fallback width when no type-specific default applies.
export const COL_WIDTH_AUTO = "auto";

// Max allowed ch-width for string-based columns to avoid absurdly wide columns.
export const COL_WIDTH_STRING_MAX_CH = 80;
