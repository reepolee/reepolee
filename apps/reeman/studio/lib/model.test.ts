import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { add_new_table, copy_table, delete_table, generate_view, get_folder_studio_tables, get_studio_tables, read_studio_file } from "./model";
import { serialize_studio_file } from "./ddl_writer";
import type { StudioFile, StudioTable } from "./types";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");

describe("studio model actions", () => {
	test("new and copied tables use writer placeholders", () => {
		const model = example_file();
		add_new_table(model, "tags");
		copy_table(model, "authors", "editors");
		expect(model.statements.filter((item) => item.is_new).map((item) => item.object_name)).toEqual(["tags", "editors"]);
	});

	test("delete removes related statements", () => {
		const model = example_file();
		model.statements.push({ gap: "", kind: "insert", object_name: "", parent_table: "authors", text: "INSERT INTO authors VALUES (1);" });
		delete_table(model, "authors");
		expect(model.statements.some((item) => item.object_name === "authors" || item.parent_table === "authors")).toBe(false);
	});

	test("generated view is a plain column projection and comes with a drop statement", () => {
		const model = example_file();
		const recipes = table("recipes", ["id", "author_id", "display"]);
		model.statements.push({ gap: "", kind: "create_table", object_name: "recipes", text: "", table: recipes });
		generate_view(model, "recipes");
		const view = model.statements.find((item) => item.kind === "create_view");
		// Views are plain projections of the table's columns - no FK joins and no
		// <stem>_display aliases, which are optional and used only when present.
		expect(view?.text).toBe("CREATE VIEW v_recipes AS\nSELECT\n    t.id,\n    t.author_id,\n    t.display\nFROM recipes t;");
		expect(view?.text).not.toContain("LEFT JOIN");
		expect(model.statements.some((item) => item.kind === "drop_view" && item.object_name === "v_recipes")).toBe(true);
	});

	test("lego_league_ddl files using CREATE TABLE IF NOT EXISTS open through read_studio_file and list their tables", () => {
		const files = readdirSync(join(REPO_ROOT, "sql/mysql/lego_league_ddl")).filter((file) => file.endsWith(".sql")).sort();
		expect(files.length).toBeGreaterThan(0);

		for (const file of files) {
			const path = `sql/mysql/lego_league_ddl/${file}`;
			const model = read_studio_file(path);
			const expected_table = file.replace(/^\d+-/, "").replace(/\.sql$/, "");
			if (file === "411-views.sql") {
				expect(get_studio_tables(model).length).toBe(0);
			} else {
				const tables = get_studio_tables(model);
				expect(tables.map((t) => t.name)).toEqual([expected_table]);
			}
		}
	});

	test("folder table discovery includes foreign key targets from sibling DDL files", () => {
		const tables = get_folder_studio_tables("sql/mysql/lego_league_ddl/106-packages.sql");
		const names = tables.map((item) => item.name);
		expect(names).toContain("packages");
		expect(names).toContain("programmes");
		expect(names.length).toBeGreaterThan(2);
	});

	test("generated view stays separated from an existing leading view", () => {
		const model = example_file();
		const recipes = table("recipes", ["id", "author_id", "display"]);
		model.statements.push({ gap: "", kind: "create_table", object_name: "recipes", text: "", table: recipes });
		model.statements.unshift({ gap: "", kind: "drop_view", object_name: "v_authors", text: "DROP VIEW IF EXISTS v_authors;" });
		generate_view(model, "recipes");
		const output = serialize_studio_file(model);
		expect(output).toContain(";\n\nDROP VIEW IF EXISTS v_authors;");
		expect(output.startsWith("\n")).toBe(false);
	});
});

function example_file(): StudioFile {
	const authors = table("authors", ["id", "display"]);
	return {
		path: "example.sql",
		dialect: "sqlite",
		trailing: "\n",
		statements: [{ gap: "", kind: "create_table", object_name: "authors", text: "", table: authors }],
	};
}

function table(name: string, names: string[]): StudioTable {
	return {
		name,
		table_foreign_keys: [],
		table_unique_keys: [],
		table_suffix_raw: "",
		columns: names.map((column_name) => ({
			name: column_name,
			type_string: "INTEGER",
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
