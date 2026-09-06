// Fake-table column metadata for the reeman /locales page (mirrors the
// db_tables module structure). Rows are derived from config/supported_locales.ts
// by sql.ts - there is no DB table behind this "table".
const columns: Record<string, { width: string; class: string; domain?: string; filter?: boolean; grid?: boolean; }> = {
	"checkbox": { width: "10ch", class: "text-center" },
	"code": { width: "auto", class: "" },
	"name": { width: "auto", class: "" },
	"alias": { width: "15ch", class: "" },
	"active": { width: "12ch", class: "text-center", domain: "boolean", filter: true },
	"default": { width: "12ch", class: "text-center", domain: "boolean", filter: true },
};

// Route param for URL paths - the locale code is the natural identity.
const route_param = "code";

// Enable/disable delete functionality (bulk delete + record delete).
const enable_archive = true;

// Trailing filler track appended to the index grid's column widths.
const grid_filler = "1fr";

// Pagination strategy - offset is fine for a small config-backed list.
const pagination_strategy: "cursor" | "offset" = "offset";

// Render strategy - synchronous full page render.
const render_strategy: "stream" | "load" = "load";

// Template tags - not applicable to this custom page, kept for parity.
const template_tags: "flat" | "tags" = "flat";

export { columns, route_param, enable_archive, grid_filler, pagination_strategy, render_strategy, template_tags };
