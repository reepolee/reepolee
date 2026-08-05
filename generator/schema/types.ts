export interface ColumnDef {
	name: string;
	type_string: string;
	comment: string;
	is_nullable: boolean;
	is_primary_key: boolean;
	is_auto_increment: boolean;
	is_generated?: boolean;
}

export interface ForeignKeyDef {
	constraint_name: string;
	column_name: string;
	referenced_table_name: string;
	referenced_column_name: string;
}

export interface ParentInfo {
	table: string;
	fk_column: string;
	route_param: string;
	label: string;
}

export interface SchemaObject {
	type: "table" | "view";
	name: string;
	comment?: string;
	columns: ColumnDef[];
	view_columns?: ColumnDef[];
	foreign_keys: ForeignKeyDef[];
	has_view: boolean;
	parent?: ParentInfo;
}

export interface ColumnAttributes {
	label?: string;
	type?: string;
	min?: string | number;
	max?: string | number;
	omit?: boolean;
	filter?: boolean;
	foreign_key?: { table: string; column: string; };
	[key: string]: any;
}

export interface FormFieldDef {
	name: string;
	type: string;
	required: boolean;
	is_nullable: boolean;
	min?: string | number;
	max?: string | number;
	attributes?: ColumnAttributes;
}
