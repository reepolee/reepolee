export type { modules_type } from "./table.generated";
export { fields, indexed_columns, v_fields } from "./table.generated";

// domain - canonical domain type from DOMAIN_TYPES taxonomy. Null when no match.
// Add compliant column to flag SQL mismatches against the canonical type.
// grid - set to false to hide from index grid while keeping for filtering.
const columns: Record<string, {
	width: string;
	class: string;
	domain?: string;
	filter?: boolean;
	grid?: boolean;
}> = {
	checkbox: { width: "10ch", class: "text-center" },
	id: { width: "10ch", class: "" },
	code: { width: "15ch", class: "" },
	name: { width: "30ch", class: "", domain: "street_extra" },
	description: { width: "80ch", class: "", domain: "first_name" },
};

// Route param for URL paths - change to a different column for URL obscurity.
const route_param = "id";

// Enable/disable delete functionality (bulk delete + record delete).
// Set to true to enable delete for this table. Children in nested CRUD always have delete enabled.
const enable_delete = false;

// Pagination strategy: "cursor" (keyset-based) or "offset" (LIMIT/OFFSET).
// Cursor is best for real-time tables, offset for numbered navigation.
// Set at schema generation time via reeman or --pagination flag.
const pagination_strategy: "cursor" | "offset" = "offset";

// Render strategy: "load" (synchronous, full page after DB query) or "stream" (progressive via DPU).
// Streaming sends the page shell immediately, then streams records and pagination
// as <template for> chunks after DB queries resolve.
const render_strategy: "stream" | "load" = "load";
export { columns, enable_delete, pagination_strategy, render_strategy, route_param };
