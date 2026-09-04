export type { global_scopes_type } from "./schema.generated";
export { fields, indexed_columns, v_fields } from "./schema.generated";

const columns: Record<string, {
	width: string;
	class: string;
	domain?: string;
	filter?: boolean;
	grid?: boolean;
	localized?: boolean;
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

// Enable/disable the destructive action (record + bulk). For a table carrying
// an archived_at column this archives (soft delete); otherwise it hard-deletes.
// Children in nested CRUD always have this action enabled.
const enable_archive = false;

// Pagination strategy: "cursor" (keyset-based) or "offset" (LIMIT/OFFSET).
const pagination_strategy: "cursor" | "offset" = "offset";

const render_strategy: "stream" | "load" = "load";

export { columns, enable_archive, pagination_strategy, render_strategy, route_param };
export const navigation = {
	section_key: "reeman.nav.data",
	item_order: 20,
	section_order: 20,
	group_order: null,
	final_order: null,
};
