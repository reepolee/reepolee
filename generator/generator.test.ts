import { describe, expect, test } from "bun:test";

// ---------------------------------------------------------------------------
// 1. validation_generator.ts
// ---------------------------------------------------------------------------
const vg = await import("./validation_generator");

describe("validation_generator", () => {
	describe("is_boolean_field", () => {
		test("detects boolean prefixes", () => {
			expect(vg.is_boolean_field("is_active")).toBe(true);
			expect(vg.is_boolean_field("has_access")).toBe(true);
			expect(vg.is_boolean_field("can_edit")).toBe(true);
		});

		test("rejects non-boolean fields", () => {
			expect(vg.is_boolean_field("name")).toBe(false);
			expect(vg.is_boolean_field("email")).toBe(false);
			expect(vg.is_boolean_field("should_notify")).toBe(false);
		});
	});

	describe("entry_fields", () => {
		test("filters out omitted fields", () => {
			const fields = [
				{ name: "id", type: "number", required: true },
				{ name: "name", type: "text", required: true },
				{ name: "secret", type: "text", required: true, attributes: { omit: true } },
			];
			const result = vg.entry_fields(fields);
			expect(result).toHaveLength(2);
			expect(result.map((f: any) => f.name)).toEqual(["id", "name"]);
		});

		test("returns all when none omitted", () => {
			const fields = [
				{ name: "a", type: "text", required: true },
				{ name: "b", type: "text", required: true },
			];
			expect(vg.entry_fields(fields)).toHaveLength(2);
		});
	});

	describe("generate_zod_fields_from_array", () => {
		const base = { name: "title", type: "text", required: true };

		test("validate mode: string defaults to z.string()", () => {
			const result = vg.generate_zod_fields_from_array([base], "validate");
			expect(result).toContain("z.string()");
		});

		test("validate mode: number gets z.coerce.number()", () => {
			const result = vg.generate_zod_fields_from_array([{ ...base, type: "number" }], "validate");
			expect(result).toContain("z.coerce.number()");
		});

		test("validate mode: number with min/max constraints", () => {
			const result = vg.generate_zod_fields_from_array([
				{ ...base, type: "number", min: 1, max: 100 },
			], "validate");
			expect(result).toContain(".min(1, \"title_min\")");
			expect(result).toContain(".max(100, \"title_max\")");
		});

		test("validate mode: FK gets min(1, must_be_selected)", () => {
			const fk = new Map([["user_id", { table: "users" }]]);
			const result = vg.generate_zod_fields_from_array([
				{ name: "user_id", type: "number", required: true },
			], "validate", fk);
			expect(result).toContain("z.coerce.number().min(1, \"must_be_selected\")");
		});

		test("validate mode: boolean field gets min(0)", () => {
			const result = vg.generate_zod_fields_from_array([
				{ ...base, name: "is_active", type: "number" },
			], "validate");
			expect(result).toContain(".min(0, \"is_active_required\")");
		});

		test("validate mode: select gets z.enum", () => {
			const result = vg.generate_zod_fields_from_array([
				{ ...base, type: "select", attributes: { options: ["a", "b"] } },
			], "validate");
			expect(result).toContain("z.enum([\"a\",\"b\"])");
		});

		test("nullable wraps schema in z.nullable()", () => {
			const result = vg.generate_zod_fields_from_array([{ ...base, is_nullable: true }], "validate");
			expect(result).toContain("z.nullable(z.string()");
		});

		test("validate mode: required date → z_date_required", () => {
			const result = vg.generate_zod_fields_from_array([
				{ name: "event_date", type: "date", required: true },
			], "validate");
			expect(result).toContain("event_date: z_date_required");
		});

		test("validate mode: optional date → z_date_optional", () => {
			const result = vg.generate_zod_fields_from_array([
				{ name: "event_date", type: "date", required: false },
			], "validate");
			expect(result).toContain("event_date: z_date_optional");
			expect(result).not.toContain(".optional()");
		});

		test("validate mode: required datetime → z_datetime_required", () => {
			const result = vg.generate_zod_fields_from_array([
				{ name: "signed_at", type: "datetime", required: true },
			], "validate");
			expect(result).toContain("signed_at: z_datetime_required");
		});

		test("validate mode: optional datetime → z_datetime_optional", () => {
			const result = vg.generate_zod_fields_from_array([
				{ name: "signed_at", type: "datetime", required: false },
			], "validate");
			expect(result).toContain("signed_at: z_datetime_optional");
			expect(result).not.toContain(".optional()");
		});

		test("validate mode: timestamp → z_datetime_optional (when not required)", () => {
			const result = vg.generate_zod_fields_from_array([
				{ name: "created_at", type: "timestamp", required: false },
			], "validate");
			expect(result).toContain("created_at: z_datetime_optional");
		});

		test("form mode: date uses date_codec (unified)", () => {
			const result = vg.generate_zod_fields_from_array([{ ...base, type: "date" }], "form");
			expect(result).toContain("date_codec");
		});

		test("form mode: required field has no .optional()", () => {
			const result = vg.generate_zod_fields_from_array([base], "form");
			expect(result).not.toContain(".optional()");
		});

		test("form mode: optional field has .optional()", () => {
			const result = vg.generate_zod_fields_from_array([{ ...base, required: false }], "form");
			expect(result).toContain(".optional()");
		});

		test("index mode: FK uses z.coerce.number()", () => {
			const fk = new Map([["category_id", { table: "categories" }]]);
			const result = vg.generate_zod_fields_from_array([
				{ name: "category_id", type: "number", required: true },
			], "index", fk);
			expect(result).toContain("z.coerce.number()");
		});
	});

	describe("collect_validation_error_keys", () => {
		const base = { name: "title", type: "text", required: true };

		test("required string yields {field}_required", () => {
			const result = vg.collect_validation_error_keys([{ ...base, name: "name" }]);
			const keys = result.map((r: any) => r.key);
			expect(keys).toContain("name_required");
		});

		test("optional string yields no keys", () => {
			const result = vg.collect_validation_error_keys([{ ...base, required: false }]);
			expect(result).toHaveLength(0);
		});

		test("number with min/max yields _min and _max", () => {
			const result = vg.collect_validation_error_keys([
				{ ...base, type: "number", min: 1, max: 100 },
			]);
			const keys = result.map((r: any) => r.key);
			expect(keys).toContain("title_min");
			expect(keys).toContain("title_max");
		});

		test("boolean field yields {field}_required", () => {
			const result = vg.collect_validation_error_keys([
				{ ...base, name: "is_active", type: "number" },
			]);
			const keys = result.map((r: any) => r.key);
			expect(keys).toContain("is_active_required");
		});

		test("FK field yields must_be_selected", () => {
			const fk = new Map([["user_id", { table: "users" }]]);
			const result = vg.collect_validation_error_keys([
				{ name: "user_id", type: "number", required: true },
			], fk);
			const keys = result.map((r: any) => r.key);
			expect(keys).toContain("must_be_selected");
		});

		test("required date yields required and invalid_date", () => {
			const result = vg.collect_validation_error_keys([
				{ name: "event_date", type: "date", required: true },
			]);
			const keys = result.map((r: any) => r.key);
			expect(keys).toContain("invalid_date");
			expect(keys).toContain("required");
		});

		test("omitted fields are skipped", () => {
			const result = vg.collect_validation_error_keys([
				{ name: "secret", type: "text", required: true, attributes: { omit: true } },
			]);
			expect(result).toHaveLength(0);
		});

		test("maintenance fields are skipped", () => {
			const result = vg.collect_validation_error_keys([
				{ name: "updated_at", type: "text", required: true },
			]);
			expect(result).toHaveLength(0);
		});

		test("duplicate keys are deduplicated across fields", () => {
			const fk = new Map([["user_id", { table: "users" }], ["role_id", { table: "roles" }]]);
			const result = vg.collect_validation_error_keys([
				{ name: "user_id", type: "number", required: true },
				{ name: "role_id", type: "number", required: true },
			], fk);
			const must_be_selected = result.filter((r: any) => r.key === "must_be_selected");
			expect(must_be_selected).toHaveLength(1);
		});

		test("never emits an empty translation value", () => {
			const result = vg.collect_validation_error_keys([
				{ ...base, name: "name" },
				{ name: "event_date", type: "date", required: true },
			]);
			for (const row of result) {
				expect(row.value.length).toBeGreaterThan(0);
			}
		});

		test("keys align with messages emitted by generate_zod_fields_from_array", () => {
			const fields = [
				{ name: "name", type: "text", required: true },
				{ name: "score", type: "number", required: true, min: 1, max: 10 },
				{ name: "is_active", type: "number", required: true },
			];
			const zod_src = vg.generate_zod_fields_from_array(fields, "validate");
			const collected = vg.collect_validation_error_keys(fields);

			// Every message literal in the generated Zod source must have a translation key.
			const emitted = [...zod_src.matchAll(/"([a-z_]+_(?:required|min|max|invalid))"/g)].map((m: any) => m[1]);
			const collected_keys = collected.map((r: any) => r.key);

			for (const msg of emitted) {
				expect(collected_keys).toContain(msg);
			}
		});
	});
});

// ---------------------------------------------------------------------------
// 2. schema/field_generator.ts
// ---------------------------------------------------------------------------
const fg = await import("./schema/field_generator");

describe("field_generator", () => {
	describe("parse_comment_attributes", () => {
		test("parses JSON-like attributes", () => expect(fg.parse_comment_attributes("{label:\"Name\",type:\"select\"}")).toEqual({
			label: "Name",
			type: "select",
		}));

		test("handles unquoted keys", () => expect(fg.parse_comment_attributes("{label:Name,type:select}")).toEqual({
			label: "Name",
			type: "select",
		}));

		test("handles numeric values", () => expect(fg.parse_comment_attributes("{min:1,max:100}")).toEqual({
			min: 1,
			max: 100,
		}));

		test("handles boolean values", () => expect(fg.parse_comment_attributes("{omit:true}")).toEqual({ omit: true }));

		test("returns empty for empty/null comment", () => {
			expect(fg.parse_comment_attributes("")).toEqual({});
			expect(fg.parse_comment_attributes(null as any)).toEqual({});
		});

		test("returns empty for non-JSON comment", () => expect(fg.parse_comment_attributes("just a comment")).toEqual({}));
	});

	describe("infer_table_name", () => {
		test("appends s for simple names", () => {
			expect(fg.infer_table_name("user_id")).toBe("users");
			expect(fg.infer_table_name("product_id")).toBe("products");
		});

		test("y → ies", () => expect(fg.infer_table_name("category_id")).toBe("categories"));

		test("s → es", () => expect(fg.infer_table_name("address_id")).toBe("addresses"));
	});

	describe("build_table_column_map", () => {
		test("builds a map from table schemas", () => {
			const schemas = [
				{
					type: "table" as const,
					name: "legal_entities",
					columns: [
						{
							name: "id",
							type_string: "bigint(20)",
							comment: "",
							is_nullable: false,
							is_primary_key: true,
							is_auto_increment: true,
						},
						{
							name: "name",
							type_string: "text",
							comment: "",
							is_nullable: true,
							is_primary_key: false,
							is_auto_increment: false,
						},
						{
							name: "registration_number",
							type_string: "varchar(10)",
							comment: "",
							is_nullable: true,
							is_primary_key: false,
							is_auto_increment: false,
						},
					],
					foreign_keys: [],
					has_view: false,
				},
				{
					type: "table" as const,
					name: "partners",
					columns: [
						{
							name: "id",
							type_string: "int(10)",
							comment: "",
							is_nullable: false,
							is_primary_key: true,
							is_auto_increment: true,
						},
						{
							name: "legal_entity_registration_number",
							type_string: "varchar(10)",
							comment: "",
							is_nullable: false,
							is_primary_key: false,
							is_auto_increment: false,
						},
					],
					foreign_keys: [],
					has_view: false,
				},
			];
			const map = fg.build_table_column_map(schemas as any);
			expect(map.size).toBe(2);
			expect(map.get("legal_entities")).toEqual(["id", "name", "registration_number"]);
			expect(map.get("partners")).toEqual(["id", "legal_entity_registration_number"]);
		});

		test("skips views", () => {
			const schemas = [
				{
					type: "table",
					name: "users",
					columns: [{ name: "id" }],
					foreign_keys: [],
					has_view: false,
				},
				{
					type: "view",
					name: "v_users",
					columns: [{ name: "id" }],
					foreign_keys: [],
					has_view: false,
				},
			];
			const map = fg.build_table_column_map(schemas as any);
			expect(map.size).toBe(1);
			expect(map.has("v_users")).toBe(false);
		});
	});

	describe("generate_fields_object (implicit FK detection)", () => {
		const mapper = new MySQLTypeMapper();

		const legal_entities_cols = [
			{
				name: "id",
				type_string: "bigint(20)",
				comment: "",
				is_nullable: false,
				is_primary_key: true,
				is_auto_increment: true,
			},
			{
				name: "name",
				type_string: "text",
				comment: "",
				is_nullable: true,
				is_primary_key: false,
				is_auto_increment: false,
			},
			{
				name: "registration_number",
				type_string: "varchar(10)",
				comment: "",
				is_nullable: true,
				is_primary_key: false,
				is_auto_increment: false,
			},
		];

		const column_map = new Map([["legal_entities", legal_entities_cols.map((c) => c.name)]]);

		const indexed_map = new Map([["legal_entities", new Set(["id", "vat_number", "registration_number"])]]);

		test("detects implicit FK: {singular_table}_{column} pattern", () => {
			const schema_obj = {
				type: "table",
				name: "partners",
				columns: [
					{
						name: "id",
						type_string: "int(10)",
						comment: "",
						is_nullable: false,
						is_primary_key: true,
						is_auto_increment: true,
					},
					{
						name: "legal_entity_registration_number",
						type_string: "varchar(10)",
						comment: "",
						is_nullable: false,
						is_primary_key: false,
						is_auto_increment: false,
					},
				],
				foreign_keys: [],
				has_view: false,
			};

			const fields = fg.generate_fields_object(schema_obj as any, mapper, column_map);

			const fk_field = fields.legal_entity_registration_number;
			expect(fk_field).toBeDefined();
			expect(fk_field.type).toBe("select");
			expect(fk_field.attributes?.foreign_key).toEqual({
				table: "legal_entities",
				column: "registration_number",
			});
		});

		test("does not detect non-matching columns", () => {
			const schema_obj = {
				type: "table",
				name: "partners",
				columns: [
					{
						name: "id",
						type_string: "int(10)",
						comment: "",
						is_nullable: false,
						is_primary_key: true,
						is_auto_increment: true,
					},
					{
						name: "some_random_field",
						type_string: "varchar(255)",
						comment: "",
						is_nullable: true,
						is_primary_key: false,
						is_auto_increment: false,
					},
				],
				foreign_keys: [],
				has_view: false,
			};

			const fields = fg.generate_fields_object(schema_obj as any, mapper, column_map);

			const field = fields.some_random_field;
			expect(field).toBeDefined();
			expect(field.attributes?.foreign_key).toBeUndefined();
		});

		test("does not override explicit FK constraints", () => {
			// When a column has both an explicit FK constraint AND matches the pattern,
			// the explicit FK should win since it's checked first
			const schema_obj = {
				type: "table",
				name: "partners",
				columns: [
					{
						name: "id",
						type_string: "int(10)",
						comment: "",
						is_nullable: false,
						is_primary_key: true,
						is_auto_increment: true,
					},
					{
						name: "legal_entity_registration_number",
						type_string: "varchar(10)",
						comment: "",
						is_nullable: false,
						is_primary_key: false,
						is_auto_increment: false,
					},
				],
				foreign_keys: [
					{
						constraint_name: "fk_partners_legal_entity",
						column_name: "legal_entity_registration_number",
						referenced_table_name: "other_table",
						referenced_column_name: "other_column",
					},
				],
				has_view: false,
			};

			const fields = fg.generate_fields_object(schema_obj as any, mapper, column_map);

			const fk_field = fields.legal_entity_registration_number;
			expect(fk_field.attributes?.foreign_key?.table).toBe("other_table");
			expect(fk_field.attributes?.foreign_key?.column).toBe("other_column");
		});

		test("warns when source column has no index", () => {
			fg.clear_missing_index_warnings();

			const schema_obj = {
				type: "table",
				name: "partners",
				columns: [
					{
						name: "id",
						type_string: "int(10)",
						comment: "",
						is_nullable: false,
						is_primary_key: true,
						is_auto_increment: true,
					},
					{
						name: "legal_entity_registration_number",
						type_string: "varchar(10)",
						comment: "",
						is_nullable: false,
						is_primary_key: false,
						is_auto_increment: false,
					},
				],
				foreign_keys: [],
				has_view: false,
			};

			fg.generate_fields_object(schema_obj as any, mapper, column_map, indexed_map);

			const warnings = fg.get_and_clear_missing_index_warnings();
			expect(warnings.length).toBeGreaterThanOrEqual(1);
			expect(warnings[0]).toContain("partners.legal_entity_registration_number");
			expect(warnings[0]).toContain("no index on the source column");
		});

		test("warns when target column has no index", () => {
			fg.clear_missing_index_warnings();

			// Source (partners) has index on legal_entity_registration_number, but targets (legal_entities) doesn't have index on registration_number
			const index_map_partner_indexed = new Map([["legal_entities", new Set(["id", "vat_number"])], ["partners", new Set(["legal_entity_registration_number"])]]);

			const schema_obj = {
				type: "table",
				name: "partners",
				columns: [
					{
						name: "id",
						type_string: "int(10)",
						comment: "",
						is_nullable: false,
						is_primary_key: true,
						is_auto_increment: true,
					},
					{
						name: "legal_entity_registration_number",
						type_string: "varchar(10)",
						comment: "",
						is_nullable: false,
						is_primary_key: false,
						is_auto_increment: false,
					},
				],
				foreign_keys: [],
				has_view: false,
			};

			fg.generate_fields_object(schema_obj as any, mapper, column_map, index_map_partner_indexed);

			const warnings = fg.get_and_clear_missing_index_warnings();
			expect(warnings.length).toBeGreaterThanOrEqual(1);
			expect(warnings[0]).toContain("legal_entities.registration_number");
			expect(warnings[0]).toContain("no index on the target column");
		});

		test("does not warn when both sides are indexed", () => {
			fg.clear_missing_index_warnings();

			// Both sides have indexes
			const index_map_both_indexed = new Map([
				["legal_entities", new Set(["id", "vat_number", "registration_number"])],
				["partners", new Set(["legal_entity_registration_number"])],
			]);

			const schema_obj = {
				type: "table",
				name: "partners",
				columns: [
					{
						name: "id",
						type_string: "int(10)",
						comment: "",
						is_nullable: false,
						is_primary_key: true,
						is_auto_increment: true,
					},
					{
						name: "legal_entity_registration_number",
						type_string: "varchar(10)",
						comment: "",
						is_nullable: false,
						is_primary_key: false,
						is_auto_increment: false,
					},
				],
				foreign_keys: [],
				has_view: false,
			};

			fg.generate_fields_object(schema_obj as any, mapper, column_map, index_map_both_indexed);

			const warnings = fg.get_and_clear_missing_index_warnings();
			expect(warnings.length).toBe(0);
		});

		test("_id suffix still works alongside new pattern", () => {
			const schema_obj = {
				type: "table",
				name: "partners",
				columns: [
					{
						name: "id",
						type_string: "int(10)",
						comment: "",
						is_nullable: false,
						is_primary_key: true,
						is_auto_increment: true,
					},
					{
						name: "legal_entity_id",
						type_string: "int(10)",
						comment: "",
						is_nullable: true,
						is_primary_key: false,
						is_auto_increment: false,
					},
				],
				foreign_keys: [],
				has_view: false,
			};

			const fields = fg.generate_fields_object(schema_obj as any, mapper, column_map);

			const fk_field = fields.legal_entity_id;
			expect(fk_field).toBeDefined();
			expect(fk_field.type).toBe("select");
			// _id suffix should still infer the table pluralized
			expect(fk_field.attributes?.foreign_key?.table).toBe("legal_entities");
			expect(fk_field.attributes?.foreign_key?.column).toBe("id");
		});

		test("_id fallback warns when source column has no index (no column map)", () => {
			fg.clear_missing_index_warnings();

			// No column_map passed - the _id fallback fires instead of the implicit rule
			const index_map = new Map([["legal_entities", new Set(["id"])]]);

			const schema_obj = {
				type: "table",
				name: "partners",
				columns: [
					{
						name: "id",
						type_string: "int(10)",
						comment: "",
						is_nullable: false,
						is_primary_key: true,
						is_auto_increment: true,
					},
					{
						name: "legal_entity_id",
						type_string: "int(10)",
						comment: "",
						is_nullable: true,
						is_primary_key: false,
						is_auto_increment: false,
					},
				],
				foreign_keys: [],
				has_view: false,
			};

			fg.generate_fields_object(schema_obj as any, mapper, undefined, index_map);

			const warnings = fg.get_and_clear_missing_index_warnings();
			expect(warnings.length).toBeGreaterThanOrEqual(1);
			expect(warnings[0]).toContain("partners.legal_entity_id");
			expect(warnings[0]).toContain("_id suffix");
			expect(warnings[0]).toContain("no index");
		});

		test("_id fallback does not warn when source column IS indexed (no column map)", () => {
			fg.clear_missing_index_warnings();

			const index_map = new Map([["legal_entities", new Set(["id"])], ["partners", new Set(["legal_entity_id"])]]);

			const schema_obj = {
				type: "table",
				name: "partners",
				columns: [
					{
						name: "id",
						type_string: "int(10)",
						comment: "",
						is_nullable: false,
						is_primary_key: true,
						is_auto_increment: true,
					},
					{
						name: "legal_entity_id",
						type_string: "int(10)",
						comment: "",
						is_nullable: true,
						is_primary_key: false,
						is_auto_increment: false,
					},
				],
				foreign_keys: [],
				has_view: false,
			};

			fg.generate_fields_object(schema_obj as any, mapper, undefined, index_map);

			const warnings = fg.get_and_clear_missing_index_warnings();
			expect(warnings.length).toBe(0);
		});

		test("implicit rule catches _id columns with schema verification", () => {
			fg.clear_missing_index_warnings();

			// column_map IS passed - implicit rule catches legal_entity_id
			const index_map = new Map([["legal_entities", new Set(["id"])], ["partners", new Set(["legal_entity_id"])]]);

			const schema_obj = {
				type: "table",
				name: "partners",
				columns: [
					{
						name: "id",
						type_string: "int(10)",
						comment: "",
						is_nullable: false,
						is_primary_key: true,
						is_auto_increment: true,
					},
					{
						name: "legal_entity_id",
						type_string: "int(10)",
						comment: "",
						is_nullable: true,
						is_primary_key: false,
						is_auto_increment: false,
					},
				],
				foreign_keys: [],
				has_view: false,
			};

			const fields = fg.generate_fields_object(schema_obj as any, mapper, column_map, index_map);

			// No warnings since both sides are indexed
			const warnings = fg.get_and_clear_missing_index_warnings();
			expect(warnings.length).toBe(0);
			// Detected correctly via implicit rule
			expect(fields.legal_entity_id.attributes?.foreign_key?.table).toBe("legal_entities");
			expect(fields.legal_entity_id.attributes?.foreign_key?.column).toBe("id");
		});

		test("backward compatible without the new param", () => {
			const schema_obj = {
				type: "table",
				name: "partners",
				columns: [
					{
						name: "id",
						type_string: "int(10)",
						comment: "",
						is_nullable: false,
						is_primary_key: true,
						is_auto_increment: true,
					},
					{
						name: "name",
						type_string: "varchar(255)",
						comment: "",
						is_nullable: true,
						is_primary_key: false,
						is_auto_increment: false,
					},
				],
				foreign_keys: [],
				has_view: false,
			};

			// Calling without the third parameter should still work
			const fields = fg.generate_fields_object(schema_obj as any, mapper);
			expect(fields.name).toBeDefined();
			expect(fields.name.type).toBe("text");
		});
	});

	describe("capitalize_label", () => {
		test("converts snake_case to Title Case", () => expect(fg.capitalize_label("first_name")).toBe("First Name"));

		test("handles single word", () => expect(fg.capitalize_label("email")).toBe("Email"));
	});

	describe("apply_index_nullable", () => test("sets nullable for IGNORE_INDEX_FIELDS fields", () => {
		const fields = [
			{ name: "search_text", type: "text", required: true, attributes: {} },
			{ name: "name", type: "text", required: true },
		];
		fg.apply_index_nullable(fields as any);
		const search = fields.find((f) => f.name === "search_text")!;
		expect(search.required).toBe(false);
		expect(search.attributes?.nullable).toBe(true);
		// name should remain unchanged
		const name = fields.find((f) => f.name === "name")!;
		expect(name.required).toBe(true);
	}));
});

// ---------------------------------------------------------------------------
// 3. TypeMappers
// ---------------------------------------------------------------------------
const { MySQLTypeMapper } = await import("./schema/mysql/mysql_type_mapper");
const { SQLiteTypeMapper } = await import("./schema/sqlite/sqlite_type_mapper");

describe("MySQLTypeMapper", () => {
	const mapper = new MySQLTypeMapper();

	// Note: tinyint(1) matches "int" first so it returns "number", not "checkbox"
	// TEXT family and varchar/char all map to text input
	test.each([
		["int", "number"],
		["bigint(20)", "number"],
		["float", "number"],
		["double", "number"],
		["decimal(10,2)", "number"],
		["tinyint(1)", "number"],
		["tinyint(2)", "number"],
		["date", "date"],
		["datetime", "datetime"],
		["timestamp", "timestamp"],
		["time", "time"],
		["varchar(255)", "text"],
		["longtext", "text"],
		["mediumtext", "text"],
		["char(1)", "text"],
		["text", "text"],
	])("to_html_input(%s) → %s", (input, expected) => expect(mapper.to_html_input(input)).toBe(expected));

	test.each([["int", "number"], ["varchar(255)", "string"], ["tinyint(1)", "number"], ["bool", "boolean"]])("to_typescript(%s) → %s", (input, expected) => expect(mapper.to_typescript(
		input
	)).toBe(expected));
});

describe("SQLiteTypeMapper", () => {
	const mapper = new SQLiteTypeMapper();

	test.each([
		["integer", "number"],
		["int", "number"],
		["real", "number"],
		["float", "number"],
		["double", "number"],
		["date", "date"],
		["datetime", "datetime"],
		["timestamp", "timestamp"],
		["time", "time"],
		["text", "text"],
		["longtext", "text"],
		["boolean", "checkbox"],
	])("to_html_input(%s) → %s", (input, expected) => expect(mapper.to_html_input(input)).toBe(expected));

	test.each([["integer", "number"], ["real", "number"], ["text", "string"], ["boolean", "boolean"]])("to_typescript(%s) → %s", (input, expected) => expect(mapper.to_typescript(
		input
	)).toBe(expected));
});
