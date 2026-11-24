import { describe, expect, test } from "bun:test";

import { get_fk_options } from "./page";
import type { StudioTable } from "./lib/types";

describe("Studio FK options", () => {
	test("includes columns from sibling DDL tables", () => {
		const options = get_fk_options([
			studio_table("packages", ["id", "programmes_id"]),
			studio_table("programmes", ["id", "title"]),
		]);

		expect(options.map((option) => option.value)).toContain("programmes.id");
		expect(options.map((option) => option.value)).toContain("programmes.title");
	});
});

function studio_table(name: string, columns: string[]): StudioTable {
	return {
		name,
		table_foreign_keys: [],
		table_unique_keys: [],
		table_suffix_raw: "",
		columns: columns.map((column_name) => ({
			name: column_name,
			type_string: "INT",
			nullability: "unspecified",
			default_value: null,
			is_primary_key: column_name === "id",
			is_auto_increment: false,
			is_unique: false,
			is_generated: false,
			on_update_current_timestamp: false,
			modifier_order: [],
		})),
	};
}
