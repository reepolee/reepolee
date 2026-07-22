// ---------------------------------------------------------------------------
// Shared types for reeman modules
// ---------------------------------------------------------------------------

export interface MenuOption {
	key: string;
	label: string;
	description?: string;
}

export interface WhereItem {
	field: string;
	operator: string;
	value: string;
}

export interface OrderByItem {
	field: string;
	direction: "ASC" | "DESC";
}

export interface GeneratorParams {
	command: string;
	table?: string;
	prefix: string;
	force: boolean;
	sync_translate: boolean;
	parent_table?: string;
	route_name?: string;
	pagination_method?: "cursor" | "offset";
	render_strategy?: "stream" | "load";
}
