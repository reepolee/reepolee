import { expect, test } from "bun:test";

import { generate_fields_object } from "./field_generator";
import type { TypeMapper } from "./type_mapper";
import type { SchemaObject } from "./types";

const text_mapper: TypeMapper = {
	to_html_input: () => "text",
	to_typescript: () => "string",
};

test("renders _description columns as textareas unless explicitly overridden", () => {
	const schema: SchemaObject = {
		type: "table",
		name: "articles",
		columns: [
			{ name: "description", type_string: "varchar(255)", comment: "", is_nullable: false, is_primary_key: false, is_auto_increment: false },
			{ name: "short_description", type_string: "varchar(255)", comment: "", is_nullable: false, is_primary_key: false, is_auto_increment: false },
			{ name: "summary_description", type_string: "varchar(255)", comment: '{type: "text"}', is_nullable: false, is_primary_key: false, is_auto_increment: false },
		],
		foreign_keys: [],
		has_view: false,
	};

	const fields = generate_fields_object(schema, text_mapper);

	expect(fields.description?.type).toBe("textarea");
	expect(fields.short_description?.type).toBe("textarea");
	expect(fields.summary_description?.type).toBe("text");
});
