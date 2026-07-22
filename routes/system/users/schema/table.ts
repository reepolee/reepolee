export type { users_type } from "./table.generated";
export { fields, v_fields } from "./table.generated";

const columns: Record<string, {
	width: string;
	class: string;
	domain?: string;
	filter?: boolean;
	grid?: boolean;
}> = {
	checkbox: { width: "10ch", class: "text-center" },
	id: { width: "10ch", class: "" },
	username: { width: "1fr", class: "" },
	email: { width: "1fr", class: "" },
	name: { width: "1fr", class: "" },
	nickname: { width: "15ch", class: "" },
	verified_at: { width: "20ch", class: "" },
	modules_tags: { width: "auto", class: "", filter: true },
};

// Route param for URL paths - change to a different column for URL obscurity.
const route_param = "id";

// Enable/disable delete functionality (bulk delete + record delete).
// Set to true to enable delete for this table. Children in nested CRUD always have delete enabled.
const enable_delete = true;

// Pagination strategy: "cursor" (keyset-based) or "offset" (LIMIT/OFFSET).
const pagination_strategy: "cursor" | "offset" = "offset";

const render_strategy: "stream" | "load" = "load";
export { columns, enable_delete, pagination_strategy, render_strategy, route_param };
