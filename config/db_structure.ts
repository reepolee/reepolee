/** Prefix for internal/working/temp tables - these are excluded from all
 * table selection UIs, CRUD generation, and schema introspection.
 * Tables like `_temp_migration`, `_backup_data`, etc. use this prefix. */
export const INTERNAL_TABLE_PREFIX = "_" as const;

/**
 * Do not generate CRUD routes for the following tables
 */
export const IGNORE_TABLES = ["modules", "sessions", "email", "images", "users", "translations"] as const satisfies readonly string[];

/**
 * Fields managed by DB, not user input
 * those will not be checked thru schema and written to db from user data
 */
export const MAINTENANCE_FIELDS = ["created_at", "updated_at"] as const satisfies readonly string[];

/**
 * Date fields which end in, like "incorporated_on", "payment_due_by"
 * will be decoded and encoded correctly for display, form entry and database write
 */
export const DATE_SUFIXES = ["_on", "_by"] as const satisfies readonly string[];

/**
 * Datetime fields which end in, like "created_at"
 * will be decoded and encoded correctly for display, form entry and database write
 */
export const DATETIME_SUFIXES = ["_at"] as const satisfies readonly string[];

/**
 * Image fields which end in, like "portrait_image", "logo_image"
 * store an uploaded image path and render via <image-upload> in forms
 * and as a 100x100 thumbnail in grids (see lib/template_helpers.ts image_thumbnail)
 */
export const IMAGE_SUFFIXES = ["_image"] as const satisfies readonly string[];

/**
 * Fields excluded from index/list schemas
 * those fields can be supplied by the SQL select but will not get a column on index table to be displayed by default
 */
export const IGNORE_INDEX_FIELDS = ["option_text", "search_text", "hashed_password", "previous_hashed_password"] as const satisfies readonly string[];

/**
 * Fields excluded from sort options
 * these fields cannot be used for ordering results
 */
export const IGNORE_ORDER_FIELDS = ["search_text", "hashed_password", "previous_hashed_password"] as const satisfies readonly string[];

/**
 * Boolean fields
 * we treat them specially as they are integers and will always be present in form posts.
 * easier to manage and check for explicit user entry
 */
export const BOOLEAN_PREFIXES = ["is_", "has_", "can_"] as const satisfies readonly string[];

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

// Fallback width when no type-specific default applies.
export const COL_WIDTH_AUTO = "auto";

// Max allowed ch-width for string-based columns to avoid absurdly wide columns.
export const COL_WIDTH_STRING_MAX_CH = 80;
