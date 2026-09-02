export type { db_tables_type } from "./schema.generated"; export { v_fields, fields, indexed_columns } from "./schema.generated";

// domain - canonical domain type from DOMAIN_TYPES taxonomy. Null when no match.
// Add compliant column to flag SQL mismatches against the canonical type.
// grid - set to false to hide from index grid while keeping for filtering.
// localized - set to true to give this column its own value per locale.
const columns: Record<string, { width: string; class: string; domain?: string; filter?: boolean; grid?: boolean; localized?: boolean }> = {
	"checkbox": { width: "10ch", class: "text-center" },
	"id": { width: "10ch", class: "", grid: false },
	"name": { width: "auto", class: "" },
	"column_count": { width: "15ch", class: "text-center" },
	"fk_count": { width: "15ch", class: "text-center" },
	"has_crud": { width: "15ch", class: "text-center", domain: "boolean" },
	"template_hash_status": { width: "15ch", class: "text-center" },
	"actions": { width: "20ch", class: "text-center" },
}

// Route param for URL paths - change to a different column for URL obscurity.
const route_param = "id";

// Enable/disable delete functionality (bulk delete + record delete).
// Set to true to enable delete for this table. Children in nested CRUD always have delete enabled.
const enable_archive = true;

// Trailing filler track appended to the index grid's column widths.
// "1fr" - filler absorbs the leftover row width, so the widths above are respected.
// "0px" - no filler width, so columns stretch to fill the row instead.
const grid_filler = "1fr";

// Pagination strategy: "cursor" (keyset-based) or "offset" (LIMIT/OFFSET).
// Cursor is best for real-time tables, offset for numbered navigation.
// Set at schema generation time via reeman or --pagination flag.
const pagination_strategy: "cursor" | "offset" = "offset";

// Render strategy: "load" (synchronous, full page after DB query) or "stream" (progressive via DPU).
// Streaming sends the page shell immediately, then streams records and pagination
// as <template for> chunks after DB queries resolve.
const render_strategy: "stream" | "load" = "load";

// Template tags: "flat" (raw <input>/<select> markup per field, generated inline) or
// "tags" (single self-contained ReeTag component per field, e.g. <input-text>).
// Use "tags" once a form's layout is stable and won't need per-field HTML customization.
const template_tags: "flat" | "tags" = "flat";
export { columns, route_param, enable_archive, grid_filler, pagination_strategy, render_strategy, template_tags };
export const navigation = {
	section_key: "reeman.nav.generator",
	item_order: 10,
	section_order: 10,
	group_order: null,
	final_order: null,
};
