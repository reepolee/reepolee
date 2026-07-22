import { describe, expect, mock, test } from "bun:test";
import { join } from "node:path";

import { get_test_db_connection, make_test_db_mock } from "$root/test_helpers";

// ---------------------------------------------------------------------------
// Test DB fixture - cloned MySQL test DB via TEST_CONNECTION_STRING
// Run `bun run db:clone-test -- --yes --no-data` first.
// ---------------------------------------------------------------------------

const test_db = get_test_db_connection();

// ---------------------------------------------------------------------------
// Mock config/db (using relative path matching source) so lazy imports
// in file_writer.ts use the test DB connection.
// ---------------------------------------------------------------------------

mock.module("$config/db", () => make_test_db_mock(test_db));

const { write_translation_files } = await import("./file_writer");
const { singularize } = await import("../naming");
const { SQLiteTypeMapper } = await import("./sqlite/sqlite_type_mapper");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetch_translation(namespace: string, key_path: string): Promise<string | null> {
	const rows = (await test_db.unsafe(`SELECT translation FROM translations WHERE lang = 'en' AND namespace = ? AND key_path = ? LIMIT 1`, [namespace, key_path])) as Array<{ translation: string; }>;
	return rows.length > 0 ? rows[0].translation : null;
}

// Minimal SchemaObject with just enough columns for write_translation_files.
function make_schema(name: string): any {
	return {
		type: "table",
		name,
		columns: [
			{
				name: "id",
				type_string: "INTEGER",
				comment: "",
				is_nullable: false,
				is_primary_key: true,
				is_auto_increment: true,
			},
		],
		foreign_keys: [],
		has_view: false,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("write_translation_files - named route (route_name)", () => {
	test("uses route_name for route_name key when route_name is provided", async () => {
		const dir = join(process.cwd(), "routes", "test-named-translations-1");
		const schema = make_schema("companies");
		const mapper = new SQLiteTypeMapper();

		await write_translation_files(dir, schema, mapper, undefined, undefined, "my-brands");

		const route_name_value = await fetch_translation("test-named-translations-1", "route_name");
		expect(route_name_value).toBe("my-brands");
	});

	test("uses schema name (slugified) for route_name key when route_name is empty", async () => {
		const dir = join(process.cwd(), "routes", "test-named-translations-2");
		const schema = make_schema("companies");
		const mapper = new SQLiteTypeMapper();

		await write_translation_files(dir, schema, mapper, undefined, undefined, "");

		const route_name_value = await fetch_translation("test-named-translations-2", "route_name");
		expect(route_name_value).toBe("companies");
	});

	test("uses route_name even for multi-word route names", async () => {
		const dir = join(process.cwd(), "routes", "test-named-translations-3");
		const schema = make_schema("legal_entities");
		const mapper = new SQLiteTypeMapper();

		await write_translation_files(dir, schema, mapper, undefined, undefined, "my-brands-list");

		const route_name_value = await fetch_translation("test-named-translations-3", "route_name");
		expect(route_name_value).toBe("my-brands-list");
	});

	test("forward-compatible: default empty route_name does not break existing behavior", async () => {
		const dir = join(process.cwd(), "routes", "test-named-translations-4");
		const schema = make_schema("equipment");
		const mapper = new SQLiteTypeMapper();

		// Call without the optional parameter (backward compat)
		await write_translation_files(dir, schema, mapper, undefined, undefined);

		const route_name_value = await fetch_translation("test-named-translations-4", "route_name");
		expect(route_name_value).toBe("equipment");
	});
});

describe("singularize", () => {
	test("singularizes route_name hyphens gracefully", () => expect(singularize("my-brands")).toBe("my-brand"));

	test("singularizes regular table name", () => expect(singularize("companies")).toBe("company"));
});
