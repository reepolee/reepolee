/**
* Integration tests for schema_reader.load_table_schema.
*
* Uses a cloned MySQL test DB as the DB fixture, temp directories
* with real schema files on disk, and mock.module for config modules.
*
* Tests the full pipeline: filesystem -> dynamic import -> metadata extraction.
*/

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { get_test_db_connection } from "$root/test_helpers";

// ---------------------------------------------------------------------------
// Test DB fixture - uses TEST_CONNECTION_STRING for the cloned MySQL test DB.
// ---------------------------------------------------------------------------

const test_db = get_test_db_connection();

// Create test-only tables (MySQL syntax)
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
	CREATE TABLE IF NOT EXISTS equipment (
		id INT AUTO_INCREMENT PRIMARY KEY,
		code VARCHAR(255) NOT NULL,
		name VARCHAR(255) NOT NULL,
		description TEXT
	);
	CREATE TABLE IF NOT EXISTS equipment_items (
		id INT AUTO_INCREMENT PRIMARY KEY,
		equipment_id INT NOT NULL,
		item_name VARCHAR(255) NOT NULL,
		quantity INT DEFAULT 1,
		notes TEXT
	);
`);

// Modules under test import from $config/db, $config/db_structure, and
// $config/supported_languages directly - no mocking needed for config constants.

// Now import the module under test
const sr = await import("./schema_reader");

// ---------------------------------------------------------------------------
// Helpers: temp directory + schema file creation
// ---------------------------------------------------------------------------

interface TempSchema {
	table_name: string;
	fields: Record<string, any>;
	columns?: Record<string, string>;
	pagination_strategy?: "cursor" | "offset";
	route_param?: string;
	parent?: { table: string; fk_column: string; route_param: string; label: string; };
	v_fields?: Record<string, any> | null;
	indexed_columns?: string[];
	enable_delete?: boolean;
}

interface TempGenerated {
	fields: Record<string, any>;
	v_fields?: Record<string, any> | null;
	indexed_columns?: string[];
	parent?: any;
}

let _tmp_counter = 0;

function setup_schema(
	table_name: string,
	schema_cfg: TempSchema,
	generated_cfg?: TempGenerated,
	prefix: string = "",
	parent_cli_table: string = "",
): { tmp: string; route_dir: string; restore: () => void; } {
	_tmp_counter++;
	const label = `${table_name}-${_tmp_counter}`;
	const tmp = mkdtempSync(join(tmpdir(), `sreader-${label}-`));

	// Build route directory path
	const route_dir_parts = [tmp, "routes"];
	if (prefix) route_dir_parts.push(prefix);
	if (parent_cli_table) route_dir_parts.push(parent_cli_table);
	route_dir_parts.push(table_name);
	const route_dir = join(...route_dir_parts);

	// Create schema directory
	const schema_dir = join(route_dir, "schema");
	mkdirSync(schema_dir, { recursive: true });

	// Write schema/table.ts
	const { fields, columns, pagination_strategy, route_param, parent, v_fields, indexed_columns, enable_delete } = schema_cfg;

	const pagination_value = pagination_strategy ?? "offset";
	const route_param_value = route_param ?? "id";
	const columns_value = columns ? JSON.stringify(columns) : `{ "checkbox": "10ch", "id": "10ch" }`;

	let parent_export = "";
	if (parent) { parent_export = `\nexport const parent = ${JSON.stringify(parent)};\n`; }

	// Build table.ts content
	let table_ts = `// Auto-generated for tests\nexport const fields = ${JSON.stringify(fields, null, 2)};\n`;

	if (v_fields !== undefined) { table_ts += `\nexport const v_fields = ${JSON.stringify(v_fields)};\n`; }

	if (indexed_columns !== undefined) { table_ts += `\nexport const indexed_columns = ${JSON.stringify(indexed_columns)};\n`; }

	table_ts += `
const columns: Record<string, string> = ${columns_value};
const route_param = "${route_param_value}";
const enable_delete = ${enable_delete ?? false};
const pagination_strategy: "cursor" | "offset" = "${pagination_value}";
${parent_export}
export { columns, route_param, enable_delete, pagination_strategy };
`;

	writeFileSync(join(schema_dir, "table.ts"), table_ts);

	// Write schema/table.generated.ts if provided
	if (generated_cfg) {
		let gen_ts = `// Auto-generated for tests\n`;

		if (generated_cfg.fields) { gen_ts += `export const fields = ${JSON.stringify(generated_cfg.fields, null, 2)};\n`; }
		if (generated_cfg.v_fields !== undefined) { gen_ts += `\nexport const v_fields = ${JSON.stringify(generated_cfg.v_fields)};\n`; }
		if (generated_cfg.indexed_columns !== undefined) { gen_ts += `\nexport const indexed_columns = ${JSON.stringify(generated_cfg.indexed_columns)};\n`; }
		if (generated_cfg.parent) { gen_ts += `\nexport const parent = ${JSON.stringify(generated_cfg.parent)};\n`; }

		writeFileSync(join(schema_dir, "table.generated.ts"), gen_ts);
	}

	// If this is a nested table with a parent, create the parent's index.ts
	if (parent_cli_table && parent) {
		const parent_dir_parts = [tmp, "routes"];
		if (prefix) parent_dir_parts.push(prefix);
		parent_dir_parts.push(parent_cli_table);
		const parent_dir = join(...parent_dir_parts);
		mkdirSync(parent_dir, { recursive: true });
		if (!existsSync(join(parent_dir, "index.ts"))) {
			writeFileSync(
				join(parent_dir, "index.ts"),
				`// Parent route file for tests`
			);
		}
	}

	// Return restore function that cleans up
	const restore = () => {
		try {
			rmSync(tmp, { recursive: true, force: true });
		} catch {}
	};

	return { tmp, route_dir, restore };
}

function run_with_cwd<T>(new_cwd: string, fn: () => Promise<T>): Promise<T> {
	const original_cwd = process.cwd;
	const original_chdir = process.chdir;

	process.cwd = () => new_cwd;
	process.chdir = (dir: string) => {};

	return fn().finally(() => {
		process.cwd = original_cwd;
		process.chdir = original_chdir;
	});
}

// ---------------------------------------------------------------------------
// Common test fields
// ---------------------------------------------------------------------------

const basic_fields: Record<string, any> = {
	name: { name: "name", type: "text", required: true, is_nullable: false, attributes: {} },
	description: {
		name: "description",
		type: "text",
		required: false,
		is_nullable: true,
		attributes: {},
	},
	price: { name: "price", type: "number", required: false, is_nullable: true, attributes: {} },
	category_id: {
		name: "category_id",
		type: "select",
		required: false,
		is_nullable: true,
		attributes: { foreign_key: { table: "categories", column: "id" } },
	},
	is_active: {
		name: "is_active",
		type: "number",
		required: false,
		is_nullable: true,
		attributes: {},
	},
	search_text: {
		name: "search_text",
		type: "text",
		required: false,
		is_nullable: true,
		attributes: {},
	},
};

// ===========================================================================
// Tests
// ===========================================================================

describe("schema_reader - load_table_schema", () => {
	// Store fixture cleanup references
	const cleanups: (() => void)[] = [];

	afterAll(async () => await test_db.close());

	afterEach(() => {
		for (const cleanup of cleanups) {
			cleanup();
		}
		cleanups.length = 0;
	});

	// -----------------------------------------------------------------------
	// Basic table
	// -----------------------------------------------------------------------

	test("loads basic table metadata", async () => {
		const { tmp, restore } = setup_schema("test_items", {
			table_name: "test_items",
			fields: basic_fields,
			columns: {
				checkbox: "10ch",
				id: "10ch",
				name: "auto",
				description: "auto",
				price: "auto",
				category_id: "auto",
				is_active: "10ch",
			},
			pagination_strategy: "cursor",
			route_param: "id",
		});
		cleanups.push(restore);

		await run_with_cwd(tmp, async () => {
			const meta = await sr.load_table_schema("test_items", {
				clean_prefix: "",
				route_prefix: "",
				parent_cli_table: "",
			});

			expect(meta.table_name).toBe("test_items");
			expect(meta.fields.length).toBeGreaterThanOrEqual(6);
			expect(meta.singular).toBe("test_item");
			expect(meta.pagination_strategy).toBe("cursor");
			expect(meta.is_nested).toBe(false);
			expect(meta.is_auto_increment_pk).toBe(true);
			expect(meta.route_param_value).toBe("id");
			expect(meta.clean_prefix).toBe("");
			expect(meta.route_prefix).toBe("");
			expect(meta.relative_dir).toBe("routes/test_items");
			expect(meta.first_field).toBe("name");
		});
	});

	test("extracts search_field with priority: search_text > title > name", async () => {
		const { tmp, restore } = setup_schema("test_items", {
			table_name: "test_items",
			fields: basic_fields,
			pagination_strategy: "offset",
		});
		cleanups.push(restore);

		await run_with_cwd(tmp, async () => {
			const meta = await sr.load_table_schema("test_items", {
				clean_prefix: "",
				route_prefix: "",
				parent_cli_table: "",
			});
			// search_text has highest priority in determine_search_field
			expect(meta.search_field).toBe("search_text");
		});
	});

	// -----------------------------------------------------------------------
	// Foreign keys
	// -----------------------------------------------------------------------

	test("extracts foreign keys from select/autocomplete fields", async () => {
		const fields_with_fk: Record<string, any> = {
			name: { name: "name", type: "text", required: true, is_nullable: false, attributes: {} },
			category_id: {
				name: "category_id",
				type: "select",
				required: false,
				is_nullable: true,
				attributes: { foreign_key: { table: "categories", column: "id" } },
			},
			owner_id: {
				name: "owner_id",
				type: "autocomplete",
				required: false,
				is_nullable: true,
				attributes: { foreign_key: { table: "users", column: "id" } },
			},
			plain_field: {
				name: "plain_field",
				type: "text",
				required: false,
				is_nullable: true,
				attributes: {},
			},
		};

		const { tmp, restore } = setup_schema("test_items", {
			table_name: "test_items",
			fields: fields_with_fk,
		});
		cleanups.push(restore);

		await run_with_cwd(tmp, async () => {
			const meta = await sr.load_table_schema("test_items", {
				clean_prefix: "",
				route_prefix: "",
				parent_cli_table: "",
			});

			expect(meta.foreign_keys.size).toBe(2);
			expect(meta.foreign_keys.has("category_id")).toBe(true);
			expect(meta.foreign_keys.get("category_id")).toEqual({
				table: "categories",
				column: "id",
				label: undefined,
			});
			expect(meta.foreign_keys.has("owner_id")).toBe(true);
			expect(meta.foreign_keys.get("owner_id")).toEqual({
				table: "users",
				column: "id",
				label: undefined,
			});
		});
	});

	// -----------------------------------------------------------------------
	// Nested CRUD (parent)
	// -----------------------------------------------------------------------

	test("detects nested CRUD when table has parent config", async () => {
		const child_fields: Record<string, any> = {
			item_name: {
				name: "item_name",
				type: "text",
				required: true,
				is_nullable: false,
				attributes: {},
			},
			quantity: {
				name: "quantity",
				type: "number",
				required: false,
				is_nullable: true,
				attributes: {},
			},
		};

		const { tmp, restore } = setup_schema("items", {
			table_name: "items",
			fields: child_fields,
			parent: { table: "equipment", fk_column: "equipment_id", route_param: "id", label: "Equipment" },
		}, undefined, "", "equipment");
		cleanups.push(restore);

		await run_with_cwd(tmp, async () => {
			const meta = await sr.load_table_schema("items", {
				clean_prefix: "",
				route_prefix: "",
				parent_cli_table: "equipment",
			});

			expect(meta.is_nested).toBe(true);
			expect(meta.parent_info).toBeDefined();
			expect(meta.parent_info.table).toBe("equipment");
			expect(meta.parent_info.fk_column).toBe("equipment_id");
			expect(meta.parent_dir.split(sep).join("/")).toContain("routes/equipment");
			expect(meta.relative_dir).toBe("routes/equipment/items");
		});
	});

	test("detects nested CRUD with prefix", async () => {
		const child_fields: Record<string, any> = {
			item_name: {
				name: "item_name",
				type: "text",
				required: true,
				is_nullable: false,
				attributes: {},
			},
		};

		const { tmp, restore } = setup_schema("items", {
			table_name: "items",
			fields: child_fields,
			parent: { table: "equipment", fk_column: "equipment_id", route_param: "id", label: "Equipment" },
		}, undefined, "system", "equipment");
		cleanups.push(restore);

		await run_with_cwd(tmp, async () => {
			const meta = await sr.load_table_schema("items", {
				clean_prefix: "system",
				route_prefix: "/system",
				parent_cli_table: "equipment",
			});

			expect(meta.is_nested).toBe(true);
			expect(meta.relative_dir).toBe("routes/system/equipment/items");
			expect(meta.clean_prefix).toBe("system");
		});
	});

	test("nested parent_dir falls back to prefixed route when root parent not found", async () => {
		const child_fields: Record<string, any> = {
			item_name: {
				name: "item_name",
				type: "text",
				required: true,
				is_nullable: false,
				attributes: {},
			},
		};

		const { tmp, restore } = setup_schema("items", {
			table_name: "items",
			fields: child_fields,
			parent: { table: "equipment", fk_column: "equipment_id", route_param: "id", label: "Equipment" },
		}, undefined, "system", "equipment");
		cleanups.push(restore);

		// Remove the parent's index.ts (it was created by setup_schema)
		// to test the fallback path in load_table_schema
		const prefixed_parent = join(tmp, "routes", "system", "equipment");
		mkdirSync(prefixed_parent, { recursive: true });
		writeFileSync(join(prefixed_parent, "index.ts"), "// Prefixed parent route file");

		await run_with_cwd(tmp, async () => {
			const meta = await sr.load_table_schema("items", {
				clean_prefix: "system",
				route_prefix: "/system",
				parent_cli_table: "equipment",
			});

			expect(meta.is_nested).toBe(true);
			expect(meta.parent_dir.split(sep).join("/")).toContain("routes/system/equipment");
		});
	});

	// -----------------------------------------------------------------------
	// Prefix handling
	// -----------------------------------------------------------------------

	test("applies prefix to crud_name and route paths", async () => {
		const { tmp, restore } = setup_schema("test_items", {
			table_name: "test_items",
			fields: {
				name: { name: "name", type: "text", required: true, is_nullable: false, attributes: {} },
			},
		}, undefined, "admin");
		cleanups.push(restore);

		await run_with_cwd(tmp, async () => {
			const meta = await sr.load_table_schema("test_items", {
				clean_prefix: "admin",
				route_prefix: "/admin",
				parent_cli_table: "",
			});

			expect(meta.crud_name).toBe("admin_test_items_crud");
			expect(meta.clean_prefix).toBe("admin");
			expect(meta.route_prefix).toBe("/admin");
			expect(meta.relative_dir).toBe("routes/admin/test_items");
			expect(meta.route_dir.split(sep).join("/")).toContain("routes/admin/test_items");
		});
	});

	test("handles empty prefix", async () => {
		const { tmp, restore } = setup_schema("test_items", {
			table_name: "test_items",
			fields: {
				name: { name: "name", type: "text", required: true, is_nullable: false, attributes: {} },
			},
		});
		cleanups.push(restore);

		await run_with_cwd(tmp, async () => {
			const meta = await sr.load_table_schema("test_items", {
				clean_prefix: "",
				route_prefix: "",
				parent_cli_table: "",
			});

			expect(meta.crud_name).toBe("test_items_crud");
			expect(meta.relative_dir).toBe("routes/test_items");
		});
	});

	// -----------------------------------------------------------------------
	// Generated fields
	// -----------------------------------------------------------------------

	test("loads generated fields from table.generated.ts", async () => {
		const gen_fields: Record<string, any> = {
			name: { name: "name", type: "text", required: true, is_nullable: false, attributes: {} },
			status: {
				name: "status",
				type: "text",
				required: false,
				is_nullable: true,
				attributes: { omit: true },
			},
		};

		const { tmp, restore } = setup_schema("test_items", {
			table_name: "test_items",
			fields: {
				name: { name: "name", type: "text", required: true, is_nullable: false, attributes: {} },
			},
		}, { fields: gen_fields, indexed_columns: ["name", "status"], v_fields: null });
		cleanups.push(restore);

		await run_with_cwd(tmp, async () => {
			const meta = await sr.load_table_schema("test_items", {
				clean_prefix: "",
				route_prefix: "",
				parent_cli_table: "",
			});

			expect(meta.generated_fields).toBeDefined();
			expect(Object.keys(meta.generated_fields!)).toContain("name");
			expect(Object.keys(meta.generated_fields!)).toContain("status");
			expect(meta.indexed_columns).toContain("name");
		});
	});

	test("handles missing table.generated.ts gracefully", async () => {
		const { tmp, restore } = setup_schema("test_items", {
			table_name: "test_items",
			fields: {
				name: { name: "name", type: "text", required: true, is_nullable: false, attributes: {} },
			},
		});
		cleanups.push(restore);

		await run_with_cwd(tmp, async () => {
			const meta = await sr.load_table_schema("test_items", {
				clean_prefix: "",
				route_prefix: "",
				parent_cli_table: "",
			});

			expect(meta.generated_fields).toBeNull();
			expect(meta.indexed_columns).toBeUndefined();
		});
	});

	// -----------------------------------------------------------------------
	// View fields (v_fields)
	// -----------------------------------------------------------------------

	test("uses v_fields as list_fields when present", async () => {
		const view_fields: Record<string, any> = {
			name: { name: "name", type: "text", required: true, is_nullable: false, attributes: {} },
			category_name: {
				name: "category_name",
				type: "text",
				required: false,
				is_nullable: true,
				attributes: {},
			},
		};

		const { tmp, restore } = setup_schema("test_items", {
			table_name: "test_items",
			fields: basic_fields,
			v_fields: view_fields,
		});
		cleanups.push(restore);

		await run_with_cwd(tmp, async () => {
			const meta = await sr.load_table_schema("test_items", {
				clean_prefix: "",
				route_prefix: "",
				parent_cli_table: "",
			});

			expect(meta.v_fields).toBeDefined();
			expect(meta.list_fields).toBe(meta.v_fields);
			expect(meta.v_fields?.length).toBe(2);
		});
	});

	test("falls back to fields when v_fields is null", async () => {
		const { tmp, restore } = setup_schema("test_items", {
			table_name: "test_items",
			fields: basic_fields,
			v_fields: null,
		});
		cleanups.push(restore);

		await run_with_cwd(tmp, async () => {
			const meta = await sr.load_table_schema("test_items", {
				clean_prefix: "",
				route_prefix: "",
				parent_cli_table: "",
			});

			expect(meta.v_fields).toBeNull();
			expect(meta.list_fields).toBe(meta.fields);
		});
	});

	// -----------------------------------------------------------------------
	// Route param
	// -----------------------------------------------------------------------

	test("detects non-id route_param from schema", async () => {
		const { tmp, restore } = setup_schema("test_items", {
			table_name: "test_items",
			fields: {
				code: { name: "code", type: "text", required: true, is_nullable: false, attributes: {} },
				name: { name: "name", type: "text", required: true, is_nullable: false, attributes: {} },
			},
			route_param: "code",
		});
		cleanups.push(restore);

		await run_with_cwd(tmp, async () => {
			const meta = await sr.load_table_schema("test_items", {
				clean_prefix: "",
				route_prefix: "",
				parent_cli_table: "",
			});

			expect(meta.route_param).toBe("code");
			expect(meta.route_param_value).toBe("code");
		});
	});

	test("defaults route_param to id when not specified", async () => {
		const { tmp, restore } = setup_schema("test_items", {
			table_name: "test_items",
			fields: {
				name: { name: "name", type: "text", required: true, is_nullable: false, attributes: {} },
			},
		});
		cleanups.push(restore);

		await run_with_cwd(tmp, async () => {
			const meta = await sr.load_table_schema("test_items", {
				clean_prefix: "",
				route_prefix: "",
				parent_cli_table: "",
			});

			expect(meta.route_param).toBe("id");
			expect(meta.route_param_value).toBe("id");
		});
	});

	// -----------------------------------------------------------------------
	// Pagination strategy
	// -----------------------------------------------------------------------

	test("uses CLI pagination override over schema value", async () => {
		const { tmp, restore } = setup_schema("test_items", {
			table_name: "test_items",
			fields: {
				name: { name: "name", type: "text", required: true, is_nullable: false, attributes: {} },
			},
			pagination_strategy: "offset",
		});
		cleanups.push(restore);

		await run_with_cwd(tmp, async () => {
			const meta = await sr.load_table_schema("test_items", {
				clean_prefix: "",
				route_prefix: "",
				parent_cli_table: "",
				pagination_strategy: "cursor",
			});

			expect(meta.pagination_strategy).toBe("cursor");
		});
	});

	test("defaults pagination to offset when neither CLI nor schema specifies", async () => {
		const { tmp, restore } = setup_schema("test_items", {
			table_name: "test_items",
			fields: {
				name: { name: "name", type: "text", required: true, is_nullable: false, attributes: {} },
			},
		});
		cleanups.push(restore);

		await run_with_cwd(tmp, async () => {
			const meta = await sr.load_table_schema("test_items", {
				clean_prefix: "",
				route_prefix: "",
				parent_cli_table: "",
			});

			expect(meta.pagination_strategy).toBe("offset");
		});
	});

	// -----------------------------------------------------------------------
	// ID type detection
	// -----------------------------------------------------------------------

	test("detects auto-increment PK when 'id' is not in fields", async () => {
		const { tmp, restore } = setup_schema("test_items", {
			table_name: "test_items",
			fields: {
				name: { name: "name", type: "text", required: true, is_nullable: false, attributes: {} },
			},
		});
		cleanups.push(restore);

		await run_with_cwd(tmp, async () => {
			const meta = await sr.load_table_schema("test_items", {
				clean_prefix: "",
				route_prefix: "",
				parent_cli_table: "",
			});

			expect(meta.is_auto_increment_pk).toBe(true);
			expect(meta.id_type).toBe("number");
			expect(meta.id_type_interface).toBe("number");
		});
	});

	test("detects non-auto-increment PK when 'id' is in fields", async () => {
		const fields_with_id: Record<string, any> = {
			id: { name: "id", type: "number", required: true, is_nullable: false, attributes: {} },
			name: { name: "name", type: "text", required: true, is_nullable: false, attributes: {} },
		};

		const { tmp, restore } = setup_schema("test_items", {
			table_name: "test_items",
			fields: fields_with_id,
		});
		cleanups.push(restore);

		await run_with_cwd(tmp, async () => {
			const meta = await sr.load_table_schema("test_items", {
				clean_prefix: "",
				route_prefix: "",
				parent_cli_table: "",
			});

			expect(meta.is_auto_increment_pk).toBe(false);
			expect(meta.id_type).toBe("number | string");
			expect(meta.id_type_interface).toBe("string");
		});
	});

	// -----------------------------------------------------------------------
	// Sort options
	// -----------------------------------------------------------------------

	test("generates sort options string from list_fields", async () => {
		const fields_with_name: Record<string, any> = {
			name: { name: "name", type: "text", required: true, is_nullable: false, attributes: {} },
			email: { name: "email", type: "text", required: false, is_nullable: true, attributes: {} },
		};

		const { tmp, restore } = setup_schema("test_items", {
			table_name: "test_items",
			fields: fields_with_name,
			indexed_columns: ["name", "email", "id"],
		});
		cleanups.push(restore);

		await run_with_cwd(tmp, async () => {
			const meta = await sr.load_table_schema("test_items", {
				clean_prefix: "",
				route_prefix: "",
				parent_cli_table: "",
			});

			const sort_opts = JSON.parse(meta.sort_options);
			expect(Array.isArray(sort_opts)).toBe(true);
			expect(sort_opts.length).toBeGreaterThanOrEqual(4);

			// Should include sort options from indexed_columns
			const values = sort_opts.map((o: any) => o.value);
			expect(values).toContain("id::asc");
			expect(values).toContain("id::desc");
			expect(values).toContain("name::asc");
			expect(values).toContain("name::desc");
		});
	});

	// -----------------------------------------------------------------------
	// Error handling
	// -----------------------------------------------------------------------

	test("throws when table.ts has no fields", async () => {
		const { tmp, restore } = setup_schema("test_items", { table_name: "test_items", fields: {} });
		cleanups.push(restore);

		await run_with_cwd(tmp, async () => await expect(sr.load_table_schema("test_items", {
			clean_prefix: "",
			route_prefix: "",
			parent_cli_table: "",
		})).rejects.toThrow("Fields not found in table.ts"));
	});

	test("throws when schema directory does not exist", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "sreader-missing-"));
		cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));

		await run_with_cwd(tmp, async () => await expect(sr.load_table_schema("nonexistent", {
			clean_prefix: "",
			route_prefix: "",
			parent_cli_table: "",
		})).rejects.toThrow());
	});

	// -----------------------------------------------------------------------
	// Singularization
	// -----------------------------------------------------------------------

	test("singularizes irregular table names", async () => {
		const { tmp, restore } = setup_schema("categories", {
			table_name: "categories",
			fields: {
				name: { name: "name", type: "text", required: true, is_nullable: false, attributes: {} },
			},
		});
		cleanups.push(restore);

		await run_with_cwd(tmp, async () => {
			const meta = await sr.load_table_schema("categories", {
				clean_prefix: "",
				route_prefix: "",
				parent_cli_table: "",
			});

			expect(meta.singular).toBe("category");
		});
	});

	test("singularizes -ies ending", async () => {
		const { tmp, restore } = setup_schema("companies", {
			table_name: "companies",
			fields: {
				name: { name: "name", type: "text", required: true, is_nullable: false, attributes: {} },
			},
		});
		cleanups.push(restore);

		await run_with_cwd(tmp, async () => {
			const meta = await sr.load_table_schema("companies", {
				clean_prefix: "",
				route_prefix: "",
				parent_cli_table: "",
			});

			expect(meta.singular).toBe("company");
		});
	});

	// -----------------------------------------------------------------------
	// First field selection
	// -----------------------------------------------------------------------

	test("selects first non-omit field as first_field", async () => {
		const fields_with_order: Record<string, any> = {
			title: { name: "title", type: "text", required: true, is_nullable: false, attributes: {} },
			id: {
				name: "id",
				type: "number",
				required: true,
				is_nullable: false,
				attributes: { omit: true },
			},
		};

		const { tmp, restore } = setup_schema("test_items", {
			table_name: "test_items",
			fields: fields_with_order,
		});
		cleanups.push(restore);

		await run_with_cwd(tmp, async () => {
			const meta = await sr.load_table_schema("test_items", {
				clean_prefix: "",
				route_prefix: "",
				parent_cli_table: "",
			});

			expect(meta.first_field).toBe("title");
		});
	});

	// -----------------------------------------------------------------------
	// Indexed columns from generated
	// -----------------------------------------------------------------------

	test("falls back to generated.ts for indexed_columns when not in table.ts", async () => {
		const { tmp, restore } = setup_schema("test_items", {
			table_name: "test_items",
			fields: {
				name: { name: "name", type: "text", required: true, is_nullable: false, attributes: {} },
			},
		}, {
			fields: {
				name: { name: "name", type: "text", required: true, is_nullable: false, attributes: {} },
			},
			indexed_columns: ["name"],
		});
		cleanups.push(restore);

		await run_with_cwd(tmp, async () => {
			const meta = await sr.load_table_schema("test_items", {
				clean_prefix: "",
				route_prefix: "",
				parent_cli_table: "",
			});

			expect(meta.indexed_columns).toEqual(["name"]);
		});
	});

	// -----------------------------------------------------------------------
	// Changed dirs tracking
	// -----------------------------------------------------------------------

	test("tracks changed directories", async () => {
		const { tmp, restore } = setup_schema("test_items", {
			table_name: "test_items",
			fields: {
				name: { name: "name", type: "text", required: true, is_nullable: false, attributes: {} },
			},
		});
		cleanups.push(restore);

		await run_with_cwd(tmp, async () => {
			const meta = await sr.load_table_schema("test_items", {
				clean_prefix: "",
				route_prefix: "",
				parent_cli_table: "",
			});

			expect(meta.changed_dirs.size).toBe(1);
			expect(meta.changed_dirs.has("routes/test_items")).toBe(true);
		});
	});

	test("includes prefix dir in changed_dirs for prefixed tables", async () => {
		const { tmp, restore } = setup_schema("test_items", {
			table_name: "test_items",
			fields: {
				name: { name: "name", type: "text", required: true, is_nullable: false, attributes: {} },
			},
		}, undefined, "admin");
		cleanups.push(restore);

		await run_with_cwd(tmp, async () => {
			const meta = await sr.load_table_schema("test_items", {
				clean_prefix: "admin",
				route_prefix: "/admin",
				parent_cli_table: "",
			});

			expect(meta.changed_dirs.has("routes/admin/test_items")).toBe(true);
		});
	});
});
