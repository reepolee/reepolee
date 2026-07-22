export type { global_scopes_type } from "./table.generated";
export { fields, indexed_columns, v_fields } from "./table.generated";

const columns: Record<string, {
	width: string;
	class: string;
	domain?: string;
	filter?: boolean;
	grid?: boolean;
}> = {
	checkbox: { width: "10ch", class: "text-center" },
	id: { width: "10ch", class: "" },
	module_code: { width: "15ch", class: "" },
	feature_name: { width: "15ch", class: "" },
	table_name: { width: "1fr", class: "" },
	scope_key: { width: "1fr", class: "" },
	display_name: { width: "1fr", class: "" },
	where_clause: { width: "auto", class: "" },
	sort_order: { width: "10ch", class: "text-right" },
	is_default: { width: "10ch", class: "text-center", domain: "boolean", filter: true },
};

// Route param for URL paths - change to a different column for URL obscurity.
const route_param = "id";

// Enable/disable delete functionality (bulk delete + record delete).
// Set to true to enable delete for this table. Children in nested CRUD always have delete enabled.
const enable_delete = false;

// Pagination strategy: "cursor" (keyset-based) or "offset" (LIMIT/OFFSET).
const pagination_strategy: "cursor" | "offset" = "offset";

const render_strategy: "stream" | "load" = "load";

export { columns, enable_delete, pagination_strategy, render_strategy, route_param };
