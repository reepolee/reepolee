export type { files_type } from "./schema.generated";
export { fields, v_fields } from "./schema.generated";

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
	file_type: { width: "10ch", class: "text-center", filter: true },
	original_filename: { width: "1fr", class: "" },
	folder: { width: "30ch", class: "", filter: true },
	s3_key: { width: "1fr", class: "" },
	title: { width: "1fr", class: "" },
	description: { width: "1fr", class: "" },
	tags: { width: "auto", class: "" },
	mime_type: { width: "20ch", class: "" },
	file_size: { width: "20ch", class: "text-right" },
	// System-managed ownership column (set from the session on every upload) -
	// surfaced in the grid for admin visibility but not user-editable.
	uploaded_by_user_id: { width: "12ch", class: "text-right", grid: true, filter: true },
};

// Route param for URL paths - change to a different column for URL obscurity.
const route_param = "id";

// Enable/disable the destructive action (record + bulk). For a table carrying
// an archived_at column this archives (soft delete); otherwise it hard-deletes.
// Children in nested CRUD always have this action enabled.
const enable_archive = true;

// Pagination strategy: "cursor" (keyset-based) or "offset" (LIMIT/OFFSET).
const pagination_strategy: "cursor" | "offset" = "offset";

const render_strategy: "stream" | "load" = "load";
export { columns, enable_archive, pagination_strategy, render_strategy, route_param };

export const navigation = {
	section_key: "reeman.nav.data",
	item_order: 40,
	section_order: 20,
	group_order: null,
	final_order: null,
};
