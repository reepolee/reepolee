export interface FieldDef {
	name: string;
	type: string;
	label?: string;
	required?: boolean;
	is_nullable?: boolean;
	min?: string | number;
	max?: string | number;
	attributes?: {
		foreign_key?: { table: string; column: string; };
		tags?: { table: string; };
		filter?: boolean;
		column_type?: string;
		rows?: number;
		omit?: boolean;
		omit_index?: boolean;
		options?: any[];
		fk_type?: string;
		[key: string]: unknown;
	};
}

export interface ParentInfo {
	table: string;
	fk_column: string;
	route_param: string;
	label?: string;
}

export type PaginationStrategy = "cursor" | "offset";
export type RenderStrategy = "stream" | "load";

// Foreign keys of a table, keyed by column name.
export type ForeignKeyMap = Map<string, { table: string; column: string; label?: string; }>;
