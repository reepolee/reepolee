import { describe, expect, test } from "bun:test";

const helpers = { ...(await import("./helpers")), ...(await import("../naming")) };

describe("crud helpers", () => {
	describe("capitalize_first", () => {
		test("capitalizes first character", () => {
			expect(helpers.capitalize_first("hello")).toBe("Hello");
			expect(helpers.capitalize_first("world")).toBe("World");
		});

		test("handles single character", () => expect(helpers.capitalize_first("a")).toBe("A"));

		test("does not change uppercase first char", () => expect(helpers.capitalize_first("Hello")).toBe("Hello"));

		test("handles empty string", () => expect(helpers.capitalize_first("")).toBe(""));
	});

	describe("user_fields", () => {
		test("filters out maintenance fields", () => {
			const fields = [
				{ name: "id", type: "number" },
				{ name: "name", type: "text" },
				{ name: "created_at", type: "timestamp" },
				{ name: "updated_at", type: "timestamp" },
			];
			const result = helpers.user_fields(fields);
			expect(result).toHaveLength(2);
			expect(result.map((f: any) => f.name)).toEqual(["id", "name"]);
		});

		test("is case-insensitive for maintenance fields", () => {
			const fields = [{ name: "name", type: "text" }, { name: "CREATED_AT", type: "timestamp" }];
			const result = helpers.user_fields(fields);
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe("name");
		});

		test("returns all fields when none are maintenance", () => {
			const fields = [{ name: "id", type: "number" }, { name: "title", type: "text" }];
			expect(helpers.user_fields(fields)).toHaveLength(2);
		});

		test("returns empty array for empty input", () => expect(helpers.user_fields([])).toEqual([]));
	});

	describe("determine_search_field", () => {
		test("prefers search_text", () => {
			const fields = [
				{ name: "id", type: "number" },
				{ name: "name", type: "text" },
				{ name: "search_text", type: "text" },
				{ name: "title", type: "text" },
			];
			expect(helpers.determine_search_field(fields)).toBe("search_text");
		});

		test("falls back to title", () => {
			const fields = [
				{ name: "id", type: "number" },
				{ name: "name", type: "text" },
				{ name: "title", type: "text" },
			];
			expect(helpers.determine_search_field(fields)).toBe("title");
		});

		test("falls back to name", () => {
			const fields = [{ name: "id", type: "number" }, { name: "name", type: "text" }];
			expect(helpers.determine_search_field(fields)).toBe("name");
		});

		test("falls back to id when no text field found", () => {
			const fields = [{ name: "id", type: "number" }];
			expect(helpers.determine_search_field(fields)).toBe("id");
		});

		test("returns id for empty array", () => expect(helpers.determine_search_field([])).toBe("id"));
	});

	describe("unique_fk_tables", () => {
		test("deduplicates by table::column key", () => {
			const fk = new Map([
				["user_id", { table: "users", column: "id" }],
				["created_by", { table: "users", column: "id" }],
				["category_id", { table: "categories", column: "id" }],
			]);
			const result = helpers.unique_fk_tables(fk);
			expect(result).toHaveLength(2);
		});

		test("returns all when no duplicates", () => {
			const fk = new Map([
				["user_id", { table: "users", column: "id" }],
				["category_id", { table: "categories", column: "id" }],
			]);
			expect(helpers.unique_fk_tables(fk)).toHaveLength(2);
		});

		test("returns empty for empty map", () => expect(helpers.unique_fk_tables(new Map())).toEqual([]));
	});

	describe("get_autocomplete_fk_tables", () => {
		test("returns FK info for autocomplete fields", () => {
			const fields = [{ name: "company_id", type: "autocomplete" }, { name: "name", type: "text" }];
			const foreign_keys = new Map([
				["company_id", { table: "companies", column: "id" }],
			]);
			const result = helpers.get_autocomplete_fk_tables(fields, foreign_keys);
			expect(result).toHaveLength(1);
			expect(result[0]).toEqual({ table: "companies", column: "id", field_name: "company_id" });
		});

		test("skips non-autocomplete fields", () => {
			const fields = [
				{ name: "user_id", type: "select" },
				{ name: "company_id", type: "autocomplete" },
			];
			const foreign_keys = new Map([
				["user_id", { table: "users", column: "id" }],
				["company_id", { table: "companies", column: "id" }],
			]);
			const result = helpers.get_autocomplete_fk_tables(fields, foreign_keys);
			expect(result).toHaveLength(1);
			expect(result[0].field_name).toBe("company_id");
		});

		test("deduplicates by table::column", () => {
			const fields = [
				{ name: "primary_company_id", type: "autocomplete" },
				{ name: "secondary_company_id", type: "autocomplete" },
			];
			const foreign_keys = new Map([
				["primary_company_id", { table: "companies", column: "id" }],
				["secondary_company_id", { table: "companies", column: "id" }],
			]);
			const result = helpers.get_autocomplete_fk_tables(fields, foreign_keys);
			expect(result).toHaveLength(1);
		});

		test("returns empty when no autocomplete fields with FK info", () => {
			const fields = [{ name: "name", type: "text" }];
			expect(helpers.get_autocomplete_fk_tables(fields, new Map())).toEqual([]);
		});
	});

	describe("generate_sort_options", () => {
		test("always includes id ascending and descending", () => {
			const result = JSON.parse(helpers.generate_sort_options([]));
			expect(result).toContainEqual({ value: "id::asc", label: "ID (Ascending)" });
			expect(result).toContainEqual({ value: "id::desc", label: "ID (Descending)" });
		});

		test("includes indexed columns when provided", () => {
			const fields = [
				{ name: "id", type: "number" },
				{ name: "name", type: "text" },
				{ name: "email", type: "text" },
			];
			const result = JSON.parse(helpers.generate_sort_options(fields, ["id", "name", "email"]));
			expect(result).toContainEqual({ value: "name::asc", label: "Name (Ascending)" });
			expect(result).toContainEqual({ value: "name::desc", label: "Name (Descending)" });
			expect(result).toContainEqual({ value: "email::asc", label: "Email (Ascending)" });
			expect(result).toContainEqual({ value: "email::desc", label: "Email (Descending)" });
		});

		test("skips IGNORE_ORDER_FIELDS in indexed columns", () => {
			const fields = [{ name: "id", type: "number" }, { name: "search_text", type: "text" }];
			const result = JSON.parse(helpers.generate_sort_options(fields, ["id", "search_text"]));
			expect(result).toHaveLength(2); // only id::asc and id::desc
		});

		test("uses fallback sortable list when no indexed columns", () => {
			const fields = [
				{ name: "id", type: "number" },
				{ name: "title", type: "text" },
				{ name: "name", type: "text" },
			];
			const result = JSON.parse(helpers.generate_sort_options(fields));
			expect(result).toContainEqual({ value: "title::asc", label: "Title (Ascending)" });
			expect(result).toContainEqual({ value: "title::desc", label: "Title (Descending)" });
			expect(result).toContainEqual({ value: "name::asc", label: "Name (Ascending)" });
			expect(result).toContainEqual({ value: "name::desc", label: "Name (Descending)" });
		});
	});

	describe("escape_regex", () => {
		test("escapes regex special characters", () => {
			expect(helpers.escape_regex("hello.world")).toBe("hello\\.world");
			expect(helpers.escape_regex("test?")).toBe("test\\?");
			expect(helpers.escape_regex("(a|b)")).toBe("\\(a\\|b\\)");
		});

		test("handles strings without special chars", () => expect(helpers.escape_regex("hello")).toBe("hello"));
	});

	describe("replace_between_markers", () => {
		test("replaces content between markers", () => {
			const content = `before\n<!-- crud:fields:start -->\nold\n<!-- crud:fields:end -->\nafter`;
			const result = helpers.replace_between_markers(content, "fields", "new content");
			expect(result).toContain("<!-- crud:fields:start -->");
			expect(result).toContain("new content");
			expect(result).toContain("<!-- crud:fields:end -->");
			expect(result).not.toContain("old");
		});

		test("throws when markers not found", () => {
			const content = "no markers here";
			expect(() => helpers.replace_between_markers(content, "fields", "new")).toThrow("Markers not found");
		});
	});

	describe("update_grid_cols", () => {
		test("replaces grid-cols-[...] class", () => {
			const content = "<div class=\"grid grid-cols-[1fr_2fr]\">fields</div>";
			const result = helpers.update_grid_cols(content, "[1fr_1fr]");
			expect(result).toBe("<div class=\"grid grid-cols-[1fr_1fr]\">fields</div>");
		});

		test("handles various grid values", () => {
			const content = "<div class=\"grid-cols-[auto_1fr]\">x</div>";
			const result = helpers.update_grid_cols(content, "[2fr_1fr]");
			expect(result).toBe("<div class=\"grid-cols-[2fr_1fr]\">x</div>");
		});

		test("returns unchanged if no match", () => {
			const content = "no grid class here";
			expect(helpers.update_grid_cols(content, "[1fr]")).toBe(content);
		});
	});

	describe("smart_merge_fields", () => {
		test("replaces existing fields with same template type and same signature (keeps old)", () => {
			const old = `<field-wrapper data-field="name">\n\t<label>Name</label>\n\t<input type="text">\n</field-wrapper>`;
			const new_blocks = [`<field-wrapper data-field="name">\n\t<label>Name</label>\n\t<input type="text">\n</field-wrapper>`];
			const result = helpers.smart_merge_fields(old, new_blocks);
			// Same template type and signature -> keep old
			expect(result).toContain("<label>Name</label>");
		});

		test("replaces field when template type changes", () => {
			const old = `<field-wrapper data-field="name">\n\t<label>Name</label>\n\t<input type="text">\n</field-wrapper>`;
			const new_blocks = [`<field-wrapper data-field="name">\n\t<label>Name</label>\n\t<textarea>text</textarea>\n</field-wrapper>`];
			const result = helpers.smart_merge_fields(old, new_blocks);
			// Template type changed (input -> textarea) -> use new
			expect(result).toContain("<textarea>");
		});

		test("removes fields that no longer exist", () => {
			const old = `<field-wrapper data-field="name">\n\t<label>Name</label>\n\t<input type="text">\n</field-wrapper>\n\n` + `<field-wrapper data-field="removed">\n\t<label>Removed</label>\n\t<input type="text">\n</field-wrapper>`;
			const new_blocks = [`<field-wrapper data-field="name">\n\t<label>Name</label>\n\t<input type="text">\n</field-wrapper>`];
			const result = helpers.smart_merge_fields(old, new_blocks);
			expect(result).not.toContain("removed");
			expect(result).not.toContain("Removed");
		});

		test("appends new fields that don't exist in old section", () => {
			const old = `<field-wrapper data-field="name">\n\t<label>Name</label>\n\t<input type="text">\n</field-wrapper>`;
			const new_blocks = [
				`<field-wrapper data-field="name">\n\t<label>Name</label>\n\t<input type="text">\n</field-wrapper>`,
				`<field-wrapper data-field="email">\n\t<label>Email</label>\n\t<input type="email">\n</field-wrapper>`,
			];
			const result = helpers.smart_merge_fields(old, new_blocks);
			expect(result).toContain("data-field=\"email\"");
			expect(result).toContain("<label>Email</label>");
		});
	});

	describe("extract_foreign_keys", () => {
		test("extracts FK info from select and autocomplete fields", () => {
			const fields = [
				{
					name: "user_id",
					type: "select",
					label: "User",
					attributes: { foreign_key: { table: "users", column: "id" } },
				},
				{
					name: "company_id",
					type: "autocomplete",
					label: "Company",
					attributes: { foreign_key: { table: "companies", column: "id" } },
				},
				{ name: "name", type: "text", label: "Name" },
			];
			const result = helpers.extract_foreign_keys(fields);
			expect(result.size).toBe(2);
			expect(result.get("user_id")).toEqual({ table: "users", column: "id", label: "User" });
			expect(result.get("company_id")).toEqual({ table: "companies", column: "id", label: "Company" });
		});

		test("skips non-select/autocomplete fields", () => {
			const fields = [
				{ name: "name", type: "text", label: "Name" },
				{ name: "count", type: "number", label: "Count" },
			];
			const result = helpers.extract_foreign_keys(fields);
			expect(result.size).toBe(0);
		});

		test("falls back to generated_fields FK info when field has no direct FK", () => {
			const fields = [{ name: "user_id", type: "select", label: "User" }];
			const generated_fields = {
				user_id: { attributes: { foreign_key: { table: "users", column: "id" } } },
			};
			const result = helpers.extract_foreign_keys(fields, generated_fields);
			expect(result.get("user_id")).toEqual({ table: "users", column: "id", label: "User" });
		});

		test("returns empty map for empty fields", () => expect(helpers.extract_foreign_keys([]).size).toBe(0));
	});
});
