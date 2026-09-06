import { describe, expect, test } from "bun:test";

import { is_non_binary_string_type, resolve_option_display_field, validate_schema_display_contract } from "./display_contract";
import type { ColumnDef, SchemaObject } from "./types";

describe("resolve_option_display_field", () => {
	test("prefers option_display when present", () => {
		const columns = [
			{ name: "id", type_string: "INTEGER" },
			{ name: "display", type_string: "TEXT" },
			{ name: "option_display", type_string: "TEXT" },
		];
		expect(resolve_option_display_field(columns)).toBe("option_display");
	});

	test("falls back to display when option_display is absent", () => {
		const columns = [
			{ name: "id", type_string: "INTEGER" },
			{ name: "display", type_string: "TEXT" },
		];
		expect(resolve_option_display_field(columns)).toBe("display");
	});

	test("falls back to the first non-binary string column when neither exists", () => {
		const columns = [
			{ name: "id", type_string: "INTEGER" },
			{ name: "title", type_string: "VARCHAR(255)" },
			{ name: "body", type_string: "TEXT" },
		];
		expect(resolve_option_display_field(columns)).toBe("title");
	});

	test("skips binary and blob columns when scanning for the string fallback", () => {
		const columns = [
			{ name: "avatar", type_string: "BLOB" },
			{ name: "uuid", type_string: "BINARY(16)" },
			{ name: "code", type_string: "CHAR(10)" },
		];
		expect(resolve_option_display_field(columns)).toBe("code");
	});

	test("degrades to the first column when no string column exists", () => {
		const columns = [
			{ name: "id", type_string: "INTEGER" },
			{ name: "count", type_string: "INTEGER" },
		];
		expect(resolve_option_display_field(columns)).toBe("id");
	});

	test("returns the display sentinel for an empty column list", () => {
		expect(resolve_option_display_field([])).toBe("display");
	});
});

describe("is_non_binary_string_type", () => {
	test("accepts char/varchar/text/clob families", () => {
		expect(is_non_binary_string_type("VARCHAR(255)")).toBe(true);
		expect(is_non_binary_string_type("TEXT")).toBe(true);
		expect(is_non_binary_string_type("CHAR(10)")).toBe(true);
		expect(is_non_binary_string_type("CLOB")).toBe(true);
		expect(is_non_binary_string_type("LONGTEXT")).toBe(true);
	});

	test("rejects binary, blob, and non-string types", () => {
		expect(is_non_binary_string_type("BINARY(16)")).toBe(false);
		expect(is_non_binary_string_type("VARBINARY(255)")).toBe(false);
		expect(is_non_binary_string_type("BLOB")).toBe(false);
		expect(is_non_binary_string_type("INTEGER")).toBe(false);
		expect(is_non_binary_string_type("TIMESTAMP")).toBe(false);
		expect(is_non_binary_string_type(null)).toBe(false);
		expect(is_non_binary_string_type(undefined)).toBe(false);
	});
});

describe("validate_schema_display_contract", () => {
	test("accepts a table without any display column", () => {
		expect(() => validate_schema_display_contract([table("teams", ["id", "title"])])).not.toThrow();
	});

	test("accepts a view without display or option_display", () => {
		const schema = table("teams", ["id", "title"]);
		expect(() => validate_schema_display_contract([schema, view("v_teams", [column("id", "INTEGER"), column("title", "TEXT")])])).not.toThrow();
	});

	test("accepts a view whose FK has no <stem>_display column", () => {
		const schema = table("teams", ["id", "title"]);
		expect(() => validate_schema_display_contract([schema, view("v_games", [column("id", "INTEGER"), column("team_id", "INTEGER"), column("score", "INTEGER")])])).not.toThrow();
	});

	test("accepts a table whose display is a generated string column", () => {
		expect(() => validate_schema_display_contract([table("teams", ["id", "title", display_column(true)])])).not.toThrow();
	});

	test("rejects a table whose display is not a generated column", () => {
		const schema = table("teams", ["id", "title", display_column(false)]);
		expect(() => validate_schema_display_contract([schema])).toThrow(/must be a generated column/);
	});

	test("rejects a view whose display column is not string-compatible", () => {
		const schema = table("teams", ["id", "title"]);
		const untyped = view("v_untyped", [column("id", "INTEGER"), column("display", "")]);
		expect(() => validate_schema_display_contract([schema, untyped])).toThrow(/string-compatible/);
	});

	test("rejects a view whose <stem>_display column is not string-compatible", () => {
		const schema = table("teams", ["id", "title"]);
		const bad_display = view("v_games", [column("id", "INTEGER"), column("team_id", "INTEGER"), column("team_display", "INTEGER")]);
		expect(() => validate_schema_display_contract([schema, bad_display])).toThrow(/string-compatible/);
	});
});

function table(name: string, column_names: Array<string | ColumnDef>): SchemaObject {
	return {
		type: "table",
		name,
		columns: column_names.map((entry) => typeof entry === "string" ? column(entry, entry === "id" ? "INTEGER" : "TEXT") : entry),
		foreign_keys: [],
		has_view: false,
	};
}

function view(name: string, columns_list: ColumnDef[]): SchemaObject {
	return {
		type: "view",
		name,
		columns: columns_list,
		foreign_keys: [],
		has_view: false,
	};
}

function column(name: string, type_string: string, is_generated = false): ColumnDef {
	return {
		name,
		type_string,
		comment: "",
		is_nullable: true,
		is_primary_key: false,
		is_auto_increment: false,
		is_generated,
	};
}

function display_column(generated: boolean): ColumnDef {
	return column("display", "TEXT", generated);
}
