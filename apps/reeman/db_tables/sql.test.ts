import { expect, test } from "bun:test";

const { resolve_db_tables_list_filter } = await import("./sql");

test("resolves the Tables page list filter", () => {
	expect(resolve_db_tables_list_filter("all")).toBe("all");
	expect(resolve_db_tables_list_filter("non_system")).toBe("non_system");
	expect(resolve_db_tables_list_filter("unknown")).toBe("non_system");
});
