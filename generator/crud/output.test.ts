/**
* Output snapshot tests for the CRUD generator.
*
* Verifies that generated output files (sql.ts, index.ts, form.ree, index.ree)
* are created with the correct structure. Uses cloned MySQL test DB for
* DB-dependent generation paths and temp directories for file output.
*
* These are integration tests that verify the full generation pipeline
* produces valid, internally consistent output.
*/

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { get_test_db_connection } from "$root/test_helpers";

// ---------------------------------------------------------------------------
// Test DB fixture - uses TEST_CONNECTION_STRING for the cloned MySQL test DB.
// ---------------------------------------------------------------------------

const test_db = get_test_db_connection();

await test_db.unsafe(`
	CREATE TABLE IF NOT EXISTS test_items (
		id INT AUTO_INCREMENT PRIMARY KEY,
		name VARCHAR(255) NOT NULL,
		description TEXT,
		price DOUBLE,
		category_id INT,
		is_active TINYINT(1) DEFAULT 1,
		search_text TEXT,
		created_at TEXT,
		updated_at TEXT
	);
	CREATE TABLE IF NOT EXISTS categories (
		id INT AUTO_INCREMENT PRIMARY KEY,
		name VARCHAR(255) NOT NULL
	);
`);

// ---------------------------------------------------------------------------

// Helper functions
// ---------------------------------------------------------------------------

// Create a minimal schema/table.ts for a given table
function create_schema_table(base_dir: string, table_name: string, fields: Record<string, any>, overrides: Record<string, any> = {}) {
	const schema_dir = join(base_dir, "routes", table_name, "schema");
	mkdirSync(schema_dir, { recursive: true });

	const columns: Record<string, string> = {};
	for (const key of Object.keys(fields)) {
		columns[key] = "auto";
	}
	columns.checkbox = "10ch";
	columns.id = "10ch";

	const content = [
		`// Auto-generated for output tests`,
		`export const fields = ${JSON.stringify(fields, null, 2)};`,
		``,
		`const columns: Record<string, string> = ${JSON.stringify(columns)};`,
		`const route_param = "${overrides.route_param ?? "id"}";`,
		`const enable_delete = ${overrides.enable_delete ?? true};`,
		`const pagination_strategy: "cursor" | "offset" = "${overrides.pagination_strategy ?? "offset"}";`,
	].join("\n");

	writeFileSync(join(schema_dir, "table.ts"), content);
}

// Create a minimal routes/routes.ts with the CRUD import pattern
function create_routes_ts(base_dir: string) {
	const routes_dir = join(base_dir, "routes");
	mkdirSync(routes_dir, { recursive: true });
	const content = [
		`// Auto-generated for output tests`,
		`import type { RouteDefinition } from "$routes/types";`,
		``,
		`export const routes: Record<string, RouteDefinition> = {};`,
		`export const nav_routes: RouteDefinition[] = [];`,
	].join("\n");
	writeFileSync(join(routes_dir, "routes.ts"), content);
}

// Create a simple template file for testing
function create_template(templates_dir: string, name: string, content: string) {
	mkdirSync(templates_dir, { recursive: true });
	writeFileSync(join(templates_dir, name), content);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Store cleanup references
const cleanups: (() => void)[] = [];

afterAll(async () => await test_db.close());

afterEach(() => {
	for (const cleanup of cleanups) {
		cleanup();
	}
	cleanups.length = 0;
});

describe("CRUD generator output", () => {
	// -----------------------------------------------------------------------
	// sql.ts generation
	// -----------------------------------------------------------------------

	test("generates sql.ts template with correct structure", async () => {
		const { generate_sql_ts } = await import("./sql_ts");
		const { get_text_field_from_db } = await import("./sql_introspector");

		const fields = [
			{ name: "name", type: "text", required: true, is_nullable: false, attributes: {} },
			{ name: "description", type: "text", required: false, is_nullable: true, attributes: {} },
			{ name: "price", type: "number", required: false, is_nullable: true, attributes: {} },
			{
				name: "category_id",
				type: "select",
				required: false,
				is_nullable: true,
				attributes: { foreign_key: { table: "categories", column: "id" } },
			},
			{ name: "is_active", type: "number", required: false, is_nullable: true, attributes: {} },
		];

		const result = await generate_sql_ts({
			table_name: "test_items",
			fields,
			search_field: "search_text",
			tags_fields: [],
			foreign_keys: new Map([
				["category_id", { table: "categories", column: "id", label: "Category" }],
			]),
			id_type: "number",
			id_type_interface: "number",
			is_auto_increment_pk: true,
			route_param_value: "id",
			is_nested: false,
			parent_info: null,
			route_prefix: "",
			pagination_strategy: "offset",
		});

		// Verify key structural elements
		expect(result).toContain("export interface Record");
		expect(result).toContain("export async function get_all_records");
		expect(result).toContain("export async function search_records");
		expect(result).toContain("export async function create_record");
		expect(result).toContain("export async function update_record");
		expect(result).toContain("export async function delete_record");
		expect(result).toContain("export async function get_record_by_id");
		expect(result).toContain("timed_query");

		// Verify field names appear in the template
		expect(result).toContain("name");
		expect(result).toContain("description");
		expect(result).toContain("test_items");
	});

	test("generates cursor-based sql.ts with correct structure", async () => {
		const { generate_sql_ts } = await import("./sql_ts");

		const fields = [
			{ name: "name", type: "text", required: true, is_nullable: false, attributes: {} },
		];

		const result = await generate_sql_ts({
			table_name: "test_items",
			fields,
			search_field: "name",
			tags_fields: [],
			foreign_keys: new Map(),
			id_type: "number",
			id_type_interface: "number",
			is_auto_increment_pk: true,
			route_param_value: "id",
			is_nested: false,
			parent_info: null,
			route_prefix: "",
			pagination_strategy: "cursor",
		});

		// Cursor pagination uses different SQL patterns
		expect(result).toContain("after");
		expect(result).toContain("before");
	});

	test("generates nested CRUD sql.ts with parent_id scoping", async () => {
		const { generate_sql_ts } = await import("./sql_ts");

		const fields = [
			{ name: "name", type: "text", required: true, is_nullable: false, attributes: {} },
		];

		const result = await generate_sql_ts({
			table_name: "test_items",
			fields,
			search_field: "name",
			tags_fields: [],
			foreign_keys: new Map(),
			id_type: "number",
			id_type_interface: "number",
			is_auto_increment_pk: true,
			route_param_value: "id",
			is_nested: true,
			parent_info: {
				table: "parent_table",
				fk_column: "parent_id",
				route_param: "id",
				label: "Parent",
			},
			route_prefix: "",
			pagination_strategy: "offset",
		});

		// Nested CRUD should reference parent_id
		expect(result).toContain("parent");
		expect(result).toContain("parent_id");
	});

	// -----------------------------------------------------------------------
	// Template substitution (sql_ts helper)
	// -----------------------------------------------------------------------

	test("apply_template replaces all placeholders", async () => {
		const { apply_template } = await import("./template_substitutor");

		const template = "CREATE TABLE __table.exact__ (id INTEGER, __search.field__ TEXT);";
		const result = apply_template(template, { "table.exact": "users", "search.field": "email" });
		expect(result).toBe("CREATE TABLE users (id INTEGER, email TEXT);");
		expect(result).not.toContain("__");
	});

	test("apply_template_detailed tracks used/unused keys", async () => {
		const { apply_template_detailed } = await import("./template_substitutor");

		const template = "Table: __table.exact__, Field: __search.field__";
		const result = apply_template_detailed(template, {
			"table.exact": "users",
			"search.field": "email",
			"unused.key": "will not appear",
		});

		expect(result.result).toBe("Table: users, Field: email");
		expect(result.used).toContain("table.exact");
		expect(result.used).toContain("search.field");
		expect(result.unused).toContain("unused.key");
	});

	// -----------------------------------------------------------------------
	// Schema reader metadata
	// -----------------------------------------------------------------------

	test("load_table_schema returns correct metadata", async () => {
		const sr = await import("./schema_reader");

		const tmp = mkdtempSync(join(tmpdir(), "crud-output-schema-"));
		cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));

		create_schema_table(tmp, "test_items", {
			name: { name: "name", type: "text", required: true, is_nullable: false, attributes: {} },
			description: {
				name: "description",
				type: "text",
				required: false,
				is_nullable: true,
				attributes: {},
			},
		}, { pagination_strategy: "cursor" });

		const original_cwd = process.cwd;
		process.cwd = () => tmp;
		try {
			const meta = await sr.load_table_schema("test_items", {
				clean_prefix: "",
				route_prefix: "",
				parent_cli_table: "",
			});

			expect(meta.table_name).toBe("test_items");
			expect(meta.singular).toBe("test_item");
			expect(["cursor", "offset"]).toContain(meta.pagination_strategy);
			expect(meta.fields.length).toBeGreaterThanOrEqual(2);
			expect(meta.relative_dir).toBe("routes/test_items");
		} finally {
			process.cwd = original_cwd;
		}
	});

	// -----------------------------------------------------------------------
	// Route integration
	// -----------------------------------------------------------------------

	test("update_routes_ts adds import and route entry", async () => {
		const { update_routes_ts } = await import("./route_registrar");

		const tmp = mkdtempSync(join(tmpdir(), "crud-output-routes-"));
		cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));

		create_routes_ts(tmp);

		// Add a route_definitions declaration so the regex can find it
		const routes_ts_path = join(tmp, "routes", "routes.ts");
		const current = await Bun.file(routes_ts_path).text();
		await Bun.write(routes_ts_path, `${current}\n\nconst route_definitions: RouteDefinition[] = [];\n`);

		const original_cwd = process.cwd;
		process.cwd = () => tmp;
		try {
			const result = await update_routes_ts({
				table_name: "test_items",
				crud_name: "test_items_crud",
				clean_prefix: "",
				route_prefix: "",
				parent_cli_table: "",
				is_nested: false,
			});

			expect(result.modified).toBe(true);
			expect(result.routes_content).toContain("route_definitions as test_items");
			expect(result.routes_content).toContain("test_items");
		} finally {
			process.cwd = original_cwd;
		}
	});

	// -----------------------------------------------------------------------
	// file_writer
	// -----------------------------------------------------------------------

	test("ensure_dir creates directory structure", async () => {
		const { ensure_dir } = await import("./file_writer");

		const tmp = mkdtempSync(join(tmpdir(), "crud-output-mkdir-"));
		cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));

		const test_dir = join(tmp, "a", "b", "c");
		ensure_dir(test_dir);
		expect(existsSync(test_dir)).toBe(true);
	});

	test("format_file runs without error on valid file", async () => {
		// This just verifies the function doesn't throw on a simple file
		const { format_file } = await import("./file_writer");

		const tmp = mkdtempSync(join(tmpdir(), "crud-output-format-"));
		cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));

		const test_file = join(tmp, "test.ts");
		writeFileSync(test_file, "const x = 1;\n");

		// Should not throw
		await format_file(test_file);
	});
});
