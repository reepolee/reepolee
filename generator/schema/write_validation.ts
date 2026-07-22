import { MAINTENANCE_FIELDS } from "$config/db_structure";

import { generate_validation_server_content, generate_zod_fields_from_array } from "../validation_generator";
import { generate_fields_object } from "./field_generator";
import type { TypeMapper } from "./type_mapper";
import type { FormFieldDef, SchemaObject } from "./types";

export async function write_validation_file(
	dir: string,
	schema_obj: SchemaObject,
	type_mapper: TypeMapper,
	all_tables_columns?: Map<string, string[]>,
	all_tables_indexes?: Map<string, Set<string>>,
): Promise<void> {
	let index_schema_source: SchemaObject;

	if (schema_obj.view_columns) {
		index_schema_source = {
			type: "view",
			name: schema_obj.name,
			columns: schema_obj.view_columns,
			foreign_keys: [],
			has_view: false,
		};
	} else {
		index_schema_source = schema_obj;
	}

	const index_base_fields = generate_fields_object(index_schema_source, type_mapper, all_tables_columns, all_tables_indexes);

	const index_fields_obj: Record<string, FormFieldDef> = {
		id: {
			name: "id",
			type: "number",
			required: false,
			min: undefined,
			max: undefined,
			attributes: {},
		},
		...index_base_fields,
	};

	const index_fields_array = Object.values(index_fields_obj);
	const { apply_index_nullable } = await import("./field_generator");
	apply_index_nullable(index_fields_array);
	const zod_index_fields = generate_zod_fields_from_array(index_fields_array, "index");

	const form_base_fields = generate_fields_object(schema_obj, type_mapper, all_tables_columns, all_tables_indexes);

	const maintenance_fields: Record<string, FormFieldDef> = {};
	for (const col of schema_obj.columns) {
		if (MAINTENANCE_FIELDS.includes(col.name.toLowerCase())) {
			maintenance_fields[col.name] = {
				name: col.name,
				type: type_mapper.to_html_input(col.type_string),
				required: false,
				min: undefined,
				max: undefined,
				attributes: {},
			};
		}
	}

	const form_fields_obj: Record<string, FormFieldDef> = {
		id: {
			name: "id",
			type: "number",
			required: false,
			min: undefined,
			max: undefined,
			attributes: {},
		},
		...form_base_fields,
		...maintenance_fields,
	};

	const form_fields_array = Object.values(form_fields_obj);
	apply_index_nullable(form_fields_array);
	const zod_form_fields = generate_zod_fields_from_array(form_fields_array, "form");

	const validate_base_fields = generate_fields_object(schema_obj, type_mapper, all_tables_columns, all_tables_indexes);

	const validate_fields_obj: Record<string, FormFieldDef> = {
		id: {
			name: "id",
			type: "number",
			required: false,
			min: undefined,
			max: undefined,
			attributes: {},
		},
		...validate_base_fields,
	};

	const validate_fields_array = Object.values(validate_fields_obj);
	apply_index_nullable(validate_fields_array);

	const zod_validate_fields = generate_zod_fields_from_array(validate_fields_array, "validate");

	const content = await generate_validation_server_content(zod_index_fields, zod_form_fields, zod_validate_fields);

	await Bun.write(`${dir}/schema/validation_server.ts`, content);
}
