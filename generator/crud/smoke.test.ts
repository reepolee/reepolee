/**
 * CRUD Generator Smoke Test
 *
 * Tests the core CRUD generation functions with mock field metadata.
 * Verifies that each generator produces valid output with expected exports/sections.
 * Does NOT require a database connection or filesystem writes - uses in-memory data only.
 */
import { describe, expect, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock field data - simulates what the schema generator produces
// ---------------------------------------------------------------------------

const mock_fields = [
	{ name: "id", type: "number", required: true },
	{ name: "name", type: "text", required: true, label: "Name" },
	{
		name: "status",
		type: "select",
		required: true,
		attributes: { options: ["active", "inactive"] },
		label: "Status",
	},
	{
		name: "user_id",
		type: "select",
		required: true,
		attributes: { foreign_key: { table: "users", column: "id" } },
		label: "User",
	},
	{
		name: "description",
		type: "textarea",
		required: false,
		label: "Description",
		attributes: { rows: 4 },
	},
	{ name: "is_active", type: "number", required: true, label: "Active" },
	{ name: "created_at", type: "timestamp", required: false },
];

const mock_foreign_keys = new Map([
	["user_id", { table: "users", column: "id", label: "User" }],
]);

const mock_columns: Record<string, { width: string; class: string; }> = {
	id: { width: "4rem", class: "" },
	name: { width: "auto", class: "" },
	status: { width: "8rem", class: "" },
	user_id: { width: "auto", class: "" },
	description: { width: "auto", class: "" },
	is_active: { width: "6rem", class: "text-center" },
};

const mock_sort_options = JSON.stringify([
	{ value: "id::asc", label: "ID (Ascending)" },
	{ value: "id::desc", label: "ID (Descending)" },
	{ value: "name::asc", label: "Name (Ascending)" },
	{ value: "name::desc", label: "Name (Descending)" },
]);

// ---------------------------------------------------------------------------
// 1. generate_index_ts - Route handler generation
// ---------------------------------------------------------------------------

describe("generate_index_ts", () => {
	test("produces valid TypeScript with expected exports", async () => {
		const { generate_index_ts } = await import("./index_ts");
		const result = await generate_index_ts({
			table_name: "test_items",
			fields: mock_fields,
			sort_options: mock_sort_options,
			view_name: "v_test_items",
			has_view: false,
			first_field: "name",
			foreign_keys: mock_foreign_keys,
		});

		// Verify essential exports exist
		expect(result).toContain("export async function get_test_items");
		expect(result).toContain("export async function post_test_items");
		expect(result).toContain("export async function get_test_items_new");
		expect(result).toContain("export async function get_test_items_edit");
		expect(result).toContain("export async function post_test_items_edit");
		expect(result).toContain("export async function post_test_items_bulk_delete");
		expect(result).toContain("export const test_items_crud");

		// No placeholder markers should remain
		expect(result).not.toMatch(/__[a-z]+\.[a-z_]+__/);
	});

	test("does not generate standalone semicolons for optional imports", async () => {
		const { generate_index_ts } = await import("./index_ts");
		const result = await generate_index_ts({
			table_name: "test_items",
			fields: [{ name: "id", type: "number", required: true, attributes: {} }],
			sort_options: mock_sort_options,
			view_name: "v_test_items",
			has_view: true,
			first_field: "id",
			foreign_keys: new Map(),
		});

		const result_lines = result.split("\n");
		const standalone_semicolons = result_lines.filter((line) => /^\s*;\s*$/.test(line));
		expect(standalone_semicolons).toEqual([]);
	});

	test("generates param extraction for fields", async () => {
		const { generate_index_ts } = await import("./index_ts");
		const result = await generate_index_ts({
			table_name: "test_items",
			fields: mock_fields,
			sort_options: mock_sort_options,
			view_name: "v_test_items",
			has_view: false,
			first_field: "name",
			foreign_keys: mock_foreign_keys,
		});

		expect(result).toContain("name: params.get(`name`)");
		expect(result).toContain("status: params.get(`status`)");
		expect(result).toContain("user_id: params.get(`user_id`)");
	});

	test("nested output is shorter (skips standalone handlers)", async () => {
		const { generate_index_ts } = await import("./index_ts");
		const nested = await generate_index_ts({
			table_name: "test_items",
			fields: mock_fields,
			sort_options: mock_sort_options,
			view_name: "v_test_items",
			has_view: false,
			first_field: "name",
			foreign_keys: mock_foreign_keys,
			is_nested: true,
			parent_info: { table: "parents", fk_column: "parent_id", route_param: "id" },
		});

		// Nested version should have fewer exports (no standalone index handlers)
		expect(nested).not.toContain("export async function get_test_items_new");
		expect(nested).not.toContain("post_test_items_bulk_delete");
		// But should still have the CRUD export
		expect(nested).toContain("export const test_items_crud");
	});

	test("renders with offset pagination", async () => {
		const { generate_index_ts } = await import("./index_ts");
		const result = await generate_index_ts({
			table_name: "test_items",
			fields: mock_fields,
			sort_options: mock_sort_options,
			view_name: "v_test_items",
			has_view: false,
			first_field: "name",
			foreign_keys: mock_foreign_keys,
			pagination_strategy: "offset",
		});

		expect(result).toContain("offset");
	});

	test("uses route_name when provided", async () => {
		const { generate_index_ts } = await import("./index_ts");
		const result = await generate_index_ts({
			table_name: "test_items",
			fields: mock_fields,
			sort_options: mock_sort_options,
			view_name: "v_test_items",
			has_view: false,
			first_field: "name",
			foreign_keys: mock_foreign_keys,
			crud_name: "my_items_crud",
			route_name: "my-items",
		});

		expect(result).toContain("export const my_items_crud");
	});
});

// ---------------------------------------------------------------------------
// 2. generate_form_ree - Form template generation
// ---------------------------------------------------------------------------

describe("generate_form_ree", () => {
	test("produces valid REE template with input fields", async () => {
		const { generate_form_ree } = await import("./form_ree");
		const result = await generate_form_ree({
			table_name: "test_items",
			fields: mock_fields,
			foreign_keys: mock_foreign_keys,
			route_prefix: "",
			route_param_value: "id",
			is_nested: false,
			parent_info: null,
			route_name: "",
		});

		// Verify structure
		expect(result).toContain("{#layout(");
		expect(result).toContain("</form>");
		expect(result).toContain("name=\"name\"");
		expect(result).toContain("name=\"status\"");
		expect(result).toContain("name=\"user_id\"");

		// FK fields render as select with foreign key table name
		expect(result).toContain("users");

		// No placeholder markers should remain
		expect(result).not.toMatch(/__[a-z]+\.[a-z_]+__/);
	});

	test("renders hidden input for parent FK in nested mode", async () => {
		const { generate_form_ree } = await import("./form_ree");
		const result = await generate_form_ree({
			table_name: "test_items",
			fields: [
				...mock_fields,
				{ name: "parent_id", type: "number", required: true, label: "Parent" },
			],
			foreign_keys: new Map([
				...mock_foreign_keys,
				["parent_id", { table: "parents", column: "id", label: "Parent" }],
			]),
			route_prefix: "",
			route_param_value: "id",
			is_nested: true,
			parent_info: { table: "parents", fk_column: "parent_id", route_param: "id" },
			route_name: "",
		});

		expect(result).toContain("type=\"hidden\"");
		expect(result).toContain("name=\"parent_id\"");
	});
});

// ---------------------------------------------------------------------------
// 3. generate_index_ree - Index template generation
// ---------------------------------------------------------------------------

describe("generate_index_ree", () => {
	test("produces valid REE template with table headers and cells", async () => {
		const { generate_index_ree } = await import("./index_ree");
		const { index_html } = await generate_index_ree({
			table_name: "test_items",
			singular: "test_item",
			fields: mock_fields,
			v_fields: null,
			columns_override: null,
			route_prefix: "",
			route_param_value: "id",
			pagination_strategy: "cursor",
			render_strategy: "load",
			route_name: "",
		});

		// Verify structure
		expect(index_html).toContain("{#layout(");
		expect(index_html).toContain("id");
		expect(index_html).toContain("name");

		// No placeholder markers should remain
		expect(index_html).not.toMatch(/__[a-z]+\.[a-z_]+__/);
	});

	test("streaming mode generates rows_html partial", async () => {
		const { generate_index_ree } = await import("./index_ree");
		const { index_html, rows_html } = await generate_index_ree({
			table_name: "test_items",
			singular: "test_item",
			fields: mock_fields,
			v_fields: null,
			columns_override: null,
			route_prefix: "",
			route_param_value: "id",
			pagination_strategy: "cursor",
			render_strategy: "stream",
			route_name: "",
		});

		expect(rows_html).not.toBeNull();
		expect(rows_html).toContain("record.id");
		expect(rows_html).toContain("record.name");
		expect(index_html).toContain("<?start name=\"records\"");
	});

	test("gates selection markup and grid widths on bulk delete", async () => {
		const templates_path = `${process.cwd()}/generator/templates`;
		const [index_template, rows_template, index_get_template, index_get_offset_template, index_get_stream_template, index_get_stream_cursor_template] = await Promise.all([
			Bun.file(`${templates_path}/index.ree`).text(),
			Bun.file(`${templates_path}/index/index_rows.ree`).text(),
			Bun.file(`${templates_path}/index/index_get.ts`).text(),
			Bun.file(`${templates_path}/index/index_get_offset.ts`).text(),
			Bun.file(`${templates_path}/index/index_get_stream.ts`).text(),
			Bun.file(`${templates_path}/index/index_get_stream_cursor.ts`).text(),
		]);

		expect(index_template).toContain("{#if enable_delete }");
		expect(rows_template).toContain("{#if props.enable_delete}");

		const handler_templates = [index_get_template, index_get_offset_template, index_get_stream_template, index_get_stream_cursor_template];
		for (const handler_template of handler_templates) {
			expect(handler_template).toContain('key !== "checkbox" || enable_delete');
		}

		expect(index_get_stream_template).toContain("enable_delete,");
		expect(index_get_stream_cursor_template).toContain("enable_delete,");
	});

	test("offset pagination uses different center display", async () => {
		const { generate_index_ree } = await import("./index_ree");
		const { index_html } = await generate_index_ree({
			table_name: "test_items",
			singular: "test_item",
			fields: mock_fields,
			v_fields: null,
			columns_override: null,
			route_prefix: "",
			route_param_value: "id",
			pagination_strategy: "offset",
			render_strategy: "load",
			route_name: "",
		});

		expect(index_html).toContain("offset + 1");
		expect(index_html).toContain("total > 0");
		expect(index_html).toContain('style="width: {= total.toString().length * 3 + 4 }ch; text-align: center"');
	});
});

// ---------------------------------------------------------------------------
// 4. Compile-time check - verifies import/usage consistency in generated code
// ---------------------------------------------------------------------------
// The static analysis below checks that every import symbol has a corresponding
// use in the code body. This catches regressions like the localized_url bug
// where a symbol was used by a template fragment but removed from the import statement.
// Known-conditional imports (like render_to_string for streaming) are excluded.
// ---------------------------------------------------------------------------

describe("compile-time check", () => test("generated index.ts has no unused imports", async () => {
	const { generate_index_ts } = await import("./index_ts");
	const generated = await generate_index_ts({
		table_name: "test_items",
		fields: mock_fields,
		sort_options: mock_sort_options,
		view_name: "v_test_items",
		has_view: false,
		first_field: "name",
		foreign_keys: mock_foreign_keys,
	});

	// Known-conditional imports - always imported but only used in specific render modes
	const conditional_imports = new Set(["render_to_string"]);

	// Parse all import statements
	const import_regex = /import\s*\{([^}]+)\}\s*from\s+/g;
	let imp_match: RegExpExecArray | null;
	const imported = new Set();
	while ((imp_match = import_regex.exec(generated)) !== null) {
		for (const part of imp_match[1].split(",")) {
			const name = part.trim().replace(/^type\s+/, "").trim();
			if (name && !name.startsWith("__") && !conditional_imports.has(name)) { imported.add(name); }
		}
	}

	// Extract code body (everything after the last import)
	const body = generated.replace(/^import\s.*$/gm, "").trim();

	// Check direction 1: every imported symbol is used in the body
	const unused: string[] = [];
	for (const sym of imported) {
		const escaped = sym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		if (!new RegExp(`\\b${escaped}\\b`).test(body)) { unused.push(sym); }
	}

	expect(unused, `Imported but never used:\n  - ${unused.join("\n  - ")}`).toEqual([]);

	// Check direction 2: verify known-required symbols from $lib/route are imported
	// if they appear in the code body (catches the localized_url class of bugs)
	const route_import_match = generated.match(/import\s*\{([^}]+)\}\s*from\s*"\$lib\/route"/);
	const required_helpers = ["localized_url"];
	const imported_route_helpers = route_import_match ? route_import_match[1].split(",").map((s) => s.trim()) : [];
	for (const helper of required_helpers) {
		const escaped = helper.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		if (new RegExp(`\\b${escaped}\\b`).test(body) && !imported_route_helpers.includes(helper)) { unused.push(`${helper} (used in body but missing from $lib/route import)`); }
	}

	expect(unused, `Import issues in generated code:\n  - ${unused.join("\n  - ")}`).toEqual([]);
}));

// ---------------------------------------------------------------------------
// 5. generate_sql_ts - SQL query function generation
// ---------------------------------------------------------------------------

describe("generate_sql_ts", () => {
	test("produces valid TypeScript with all SQL exports", async () => {
		const { generate_sql_ts } = await import("./sql_ts");
		const result = await generate_sql_ts({
			table_name: "test_items",
			fields: mock_fields,
			search_field: "name",
			tags_fields: [],
			foreign_keys: mock_foreign_keys,
			id_type: "number",
			id_type_interface: "number",
			is_auto_increment_pk: true,
			route_param_value: "id",
			is_nested: false,
			parent_info: null,
			route_prefix: "",
			pagination_strategy: "cursor",
			route_name: "",
		});

		expect(result).toContain("export async function get_all_records");
		expect(result).toContain("export async function get_record_by_id");
		expect(result).toContain("export async function search_records");
		expect(result).toContain("export async function create_record");
		expect(result).toContain("export async function update_record");
		expect(result).toContain("export async function delete_record");
		expect(result).toContain("export interface Record");
	});

	test("includes FK select functions when foreign keys exist", async () => {
		const { generate_sql_ts } = await import("./sql_ts");
		const result = await generate_sql_ts({
			table_name: "test_items",
			fields: mock_fields,
			search_field: "name",
			tags_fields: [],
			foreign_keys: mock_foreign_keys,
			id_type: "number",
			id_type_interface: "number",
			is_auto_increment_pk: true,
			route_param_value: "id",
			is_nested: false,
			parent_info: null,
			route_prefix: "",
			pagination_strategy: "cursor",
			route_name: "",
		});

		expect(result).toContain("get_users_options_by_id");
	});

	test("includes route param functions when route_param !== id", async () => {
		const { generate_sql_ts } = await import("./sql_ts");
		const result = await generate_sql_ts({
			table_name: "test_items",
			fields: mock_fields,
			search_field: "name",
			tags_fields: [],
			foreign_keys: mock_foreign_keys,
			id_type: "number",
			id_type_interface: "number",
			is_auto_increment_pk: true,
			route_param_value: "slug",
			is_nested: false,
			parent_info: null,
			route_prefix: "",
			pagination_strategy: "cursor",
			route_name: "",
		});

		expect(result).toContain("get_record_by_route_param");
		expect(result).toContain("delete_record_by_route_param");
	});

	test("no unreplaced placeholders remain in output", async () => {
		const { generate_sql_ts } = await import("./sql_ts");
		const result = await generate_sql_ts({
			table_name: "test_items",
			fields: mock_fields,
			search_field: "name",
			tags_fields: [],
			foreign_keys: mock_foreign_keys,
			id_type: "number",
			id_type_interface: "number",
			is_auto_increment_pk: true,
			route_param_value: "id",
			is_nested: false,
			parent_info: null,
			route_prefix: "",
			pagination_strategy: "cursor",
			route_name: "",
		});

		expect(result).not.toMatch(/__[a-z]+\.[a-z_]+__/);
	});

	test("nested SQL is generated correctly", async () => {
		const { generate_sql_ts } = await import("./sql_ts");
		const result = await generate_sql_ts({
			table_name: "test_items",
			fields: mock_fields,
			search_field: "name",
			tags_fields: [],
			foreign_keys: mock_foreign_keys,
			id_type: "number",
			id_type_interface: "number",
			is_auto_increment_pk: true,
			route_param_value: "id",
			is_nested: true,
			parent_info: {
				table: "parents",
				fk_column: "parent_id",
				route_param: "id",
				label: "Parent",
			},
			route_prefix: "",
			pagination_strategy: "cursor",
			route_name: "",
		});

		expect(result).toContain("parent_id");
	});
});
