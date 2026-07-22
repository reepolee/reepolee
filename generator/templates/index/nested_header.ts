const feature = get_table_name_from_dir(import.meta.dir);
const route_prefix = "__route_prefix__";
const PARENT_FK_COLUMN = "__parent.fk_column__";

function base_path(parent_id: number | string): string {
	return `${route_prefix}/__parent.table__/${String(parent_id)}/__table.exact__`;
}

function entity_path(parent_id: number | string, child_id?: number | string): string {
	return child_id ? `${base_path(parent_id)}/${child_id}/edit` : base_path(parent_id);
}

function child_data_path(parent_id: number | string, child_id: number | string): string {
	return `${base_path(parent_id)}/${child_id}/edit-data`;
}
