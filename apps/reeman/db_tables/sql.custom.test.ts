import { beforeEach, expect, mock, test } from "bun:test";

const queries: string[] = [];

mock.module("$config/db", () => ({
	db: {
		unsafe: async (query: string) => {
			queries.push(query);
			return [{ id: 7, name: "Rain collector", hashed_password: "never expose" }];
		},
	},
}));

mock.module("$generator/ddl_cache", () => ({
	load_ddl_cache: async () => ({
		tables: [{
			name: "metrics",
			columns: [
				{ name: "id" },
				{ name: "name" },
				{ name: "hashed_password" },
			],
			primary_key: { name: "id" },
			foreign_keys: [],
			inferred_foreign_keys: [],
			view_foreign_keys: [],
		}, {
			name: "users",
			columns: [{ name: "id" }],
			primary_key: { name: "id" },
			foreign_keys: [],
			inferred_foreign_keys: [],
			view_foreign_keys: [],
		}],
	}),
}));

mock.module("$generator/reeman/utils/route_scan", () => ({
	discover_existing_crud_tables: () => [],
}));

const { format_sample_value, get_table_sample_records, refresh_db_tables } = await import("./sql.custom");

beforeEach(() => {
	queries.length = 0;
});

test("formats sample values for a compact readable grid", () => {
	expect(format_sample_value(null)).toBe("-");
	expect(format_sample_value(new Uint8Array([1, 2, 3]))).toBe("[3 bytes]");
	expect(format_sample_value("x".repeat(121))).toBe(`${"x".repeat(117)}...`);
});

test("loads five safe sample records from eligible table columns", async () => {
	const sample = await get_table_sample_records("metrics", ["name", "hashed_password", "missing"]);

	expect(queries).toEqual(["SELECT `name` FROM `metrics` ORDER BY `id` ASC LIMIT 5"]);
	expect(sample).toEqual({
		columns: ["name"],
		records: [{ name: "Rain collector" }],
	});
});

test("keeps the existing non-system filter unless all tables are requested", async () => {
	expect((await refresh_db_tables()).map((table) => table.name)).toEqual(["metrics"]);
	expect((await refresh_db_tables(true)).map((table) => table.name)).toEqual(["metrics", "users"]);
});
