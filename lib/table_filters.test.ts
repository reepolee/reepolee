import { describe, expect, test } from "bun:test";

const { enrich_filter_definitions, get_filter_definitions, resolve_filters } = await import("./table_filters");

describe("get_filter_definitions", () => {
	const base_columns = {
		name: { width: "auto", class: "", filter: true, domain: "text_block" },
		author_id: { width: "20ch", class: "", filter: true },
		is_customer: { width: "10ch", class: "text-center", filter: true, domain: "boolean" },
		modules_tags: { width: "20ch", class: "", filter: true },
		vat_number: { width: "20ch", class: "", filter: true, domain: "number" },
		not_filterable: { width: "auto", class: "" },
	};

	const base_fields = {
		name: {
			name: "name",
			type: "text",
			required: false,
			is_nullable: true,
			attributes: { domain_type: "text_block" },
		},
		author_id: {
			name: "author_id",
			type: "select",
			required: false,
			is_nullable: true,
			attributes: { foreign_key: { table: "authors", column: "id" } },
		},
		is_customer: {
			name: "is_customer",
			type: "checkbox",
			required: true,
			is_nullable: false,
			attributes: { domain_type: "boolean" },
		},
		modules_tags: {
			name: "modules_tags",
			type: "tags",
			required: false,
			is_nullable: true,
			attributes: { tags: { table: "modules" } },
		},
		vat_number: {
			name: "vat_number",
			type: "number",
			required: false,
			is_nullable: true,
			attributes: { domain_type: "number" },
		},
		not_filterable: {
			name: "not_filterable",
			type: "text",
			required: false,
			is_nullable: true,
			attributes: {},
		},
	};

	test("identifies FK filter columns", () => {
		const defs = get_filter_definitions(base_columns, base_fields);
		const fk = defs.find((d) => d.key === "author_id");
		expect(fk).toBeDefined();
		expect(fk?.type).toBe("fk");
		expect(fk?.fk_table).toBe("authors");
		expect(fk?.fk_column).toBe("id");
	});

	test("identifies boolean filter columns", () => {
		const defs = get_filter_definitions(base_columns, base_fields);
		const bool = defs.find((d) => d.key === "is_customer");
		expect(bool).toBeDefined();
		expect(bool?.type).toBe("boolean");
	});

	test("identifies tags filter columns", () => {
		const defs = get_filter_definitions(base_columns, base_fields);
		const tags = defs.find((d) => d.key === "modules_tags");
		expect(tags).toBeDefined();
		expect(tags?.type).toBe("tags");
	});

	test("identifies number filter columns", () => {
		const defs = get_filter_definitions(base_columns, base_fields);
		const num = defs.find((d) => d.key === "vat_number");
		expect(num).toBeDefined();
		expect(num?.type).toBe("number");
	});

	test("identifies text filter columns", () => {
		const defs = get_filter_definitions(base_columns, base_fields);
		const text = defs.find((d) => d.key === "name");
		expect(text).toBeDefined();
		expect(text?.type).toBe("text");
	});

	test("excludes columns without filter: true", () => {
		const defs = get_filter_definitions(base_columns, base_fields);
		const nf = defs.find((d) => d.key === "not_filterable");
		expect(nf).toBeUndefined();
	});
});

describe("resolve_filters", () => {
	const defs: import("./table_filters").FilterDef[] = [
		{ key: "author_id", type: "fk", label: "Author", fk_table: "authors", fk_column: "id" },
		{ key: "is_customer", type: "boolean", label: "Customer" },
		{ key: "name", type: "text", label: "Name" },
		{ key: "vat_number", type: "number", label: "VAT Number" },
		{ key: "modules_tags", type: "tags", label: "Modules" },
	];

	test("FK IN clause", () => {
		const result = resolve_filters(defs, { author_id: "3,5" });
		expect(result.length).toBe(1);
		expect(result[0].clause).toBe("author_id IN (?, ?)");
		expect(result[0].params).toEqual(["3", "5"]);
	});

	test("FK NOT IN clause with ! prefix", () => {
		const result = resolve_filters(defs, { author_id: "!3,!5" });
		expect(result.length).toBe(1);
		expect(result[0].clause).toBe("author_id NOT IN (?, ?)");
		expect(result[0].params).toEqual(["3", "5"]);
	});

	test("FK mixed IN and NOT IN", () => {
		const result = resolve_filters(defs, { author_id: "!3,5,!7" });
		expect(result.length).toBe(2);
		expect(result[0].clause).toBe("author_id NOT IN (?, ?)");
		expect(result[0].params).toEqual(["3", "7"]);
		expect(result[1].clause).toBe("author_id IN (?)");
		expect(result[1].params).toEqual(["5"]);
	});

	test("boolean filter", () => {
		const result = resolve_filters(defs, { is_customer: "1" });
		expect(result.length).toBe(1);
		expect(result[0].clause).toBe("is_customer = ?");
		expect(result[0].params).toEqual(["1"]);
	});

	test("text filter uses LIKE with %term%", () => {
		const result = resolve_filters(defs, { name: "foo" });
		expect(result.length).toBe(1);
		expect(result[0].clause).toBe("name LIKE ?");
		expect(result[0].params).toEqual(["%foo%"]);
	});

	test("number filter exact match", () => {
		const result = resolve_filters(defs, { vat_number: "123" });
		expect(result.length).toBe(1);
		expect(result[0].clause).toBe("vat_number = ?");
		expect(result[0].params).toEqual(["123"]);
	});

	test("tags filter uses FIND_IN_SET", () => {
		const result = resolve_filters(defs, { modules_tags: "admin,editor" });
		expect(result.length).toBe(1);
		expect(result[0].clause).toBe("FIND_IN_SET(?, modules_tags) OR FIND_IN_SET(?, modules_tags)");
		expect(result[0].params).toEqual(["admin", "editor"]);
	});

	test("empty/missing params produce no clauses", () => {
		const result = resolve_filters(defs, {});
		expect(result.length).toBe(0);
	});

	test("undefined param value produces no clause", () => {
		const result = resolve_filters(defs, { name: "" });
		expect(result.length).toBe(0);
	});

	test("multiple filter types together", () => {
		const result = resolve_filters(defs, { name: "test", is_customer: "1", author_id: "1,2" });
		expect(result.length).toBe(3);
		const name_filter = result.find((r) => r.column === "name");
		expect(name_filter?.clause).toBe("name LIKE ?");
		const bool_filter = result.find((r) => r.column === "is_customer");
		expect(bool_filter?.clause).toBe("is_customer = ?");
		const fk_filter = result.find((r) => r.column === "author_id");
		expect(fk_filter?.clause).toBe("author_id IN (?, ?)");
	});
});

describe("enrich_filter_definitions", () => {
	const fk_def: import("./table_filters").FilterDef = {
		key: "author_id",
		type: "fk",
		label: "Author",
		fk_table: "authors",
		fk_column: "id",
	};
	const bool_def: import("./table_filters").FilterDef = {
		key: "is_active",
		type: "boolean",
		label: "Active",
	};
	const text_def: import("./table_filters").FilterDef = {
		key: "description",
		type: "text",
		label: "Description",
	};

	const labels: Record<string, string> = { author_id: "Author", is_active: "Is Active" };

	const all_options: Record<string, { option_value: string; option_text: string; }[]> = {
		author_id: [
			{ option_value: "1", option_text: "Alice" },
			{ option_value: "2", option_text: "Bob" },
			{ option_value: "3", option_text: "Charlie" },
			{ option_value: "4", option_text: "Diana" },
			{ option_value: "5", option_text: "Eve" },
			{ option_value: "6", option_text: "Frank" },
			{ option_value: "7", option_text: "Grace" },
			{ option_value: "8", option_text: "Hank" },
			{ option_value: "9", option_text: "Ivy" },
		],
	};

	test("uses translated label for fk def", () => {
		const result = enrich_filter_definitions([fk_def], labels, {}, {}, all_options);
		expect(result[0].display_label).toBe("Author");
	});

	test("falls back to def.label when no translation exists", () => {
		const result = enrich_filter_definitions([text_def], labels, {}, {}, {});
		expect(result[0].display_label).toBe("Description");
	});

	test("falls back to def.key when no translation or label exists", () => {
		const untitled_def: import("./table_filters").FilterDef = {
			key: "untitled_column",
			type: "text",
			label: "",
		};
		const result = enrich_filter_definitions([untitled_def], {}, {}, {}, {});
		expect(result[0].display_label).toBe("untitled_column");
	});

	test("splits options at 7 into visible and hidden, sets has_more", () => {
		const result = enrich_filter_definitions([fk_def], labels, {}, {}, all_options);
		expect(result[0].visible_options).toHaveLength(7);
		expect(result[0].visible_options[0].option_text).toBe("Alice");
		expect(result[0].visible_options[6].option_text).toBe("Grace");
		expect(result[0].hidden_options).toHaveLength(2);
		expect(result[0].hidden_options[0].option_text).toBe("Hank");
		expect(result[0].hidden_options[1].option_text).toBe("Ivy");
		expect(result[0].has_more).toBe(true);
	});

	test("has_more false when 7 or fewer options", () => {
		const few_options = { author_id: all_options.author_id.slice(0, 5) };
		const result = enrich_filter_definitions([fk_def], labels, {}, {}, few_options);
		expect(result[0].visible_options).toHaveLength(5);
		expect(result[0].hidden_options).toHaveLength(0);
		expect(result[0].has_more).toBe(false);
	});

	test("has_more false with exactly 7 options", () => {
		const seven_options = { author_id: all_options.author_id.slice(0, 7) };
		const result = enrich_filter_definitions([fk_def], labels, {}, {}, seven_options);
		expect(result[0].visible_options).toHaveLength(7);
		expect(result[0].hidden_options).toHaveLength(0);
		expect(result[0].has_more).toBe(false);
	});

	test("sets checked_values from comma-separated filter params for fk", () => {
		const result = enrich_filter_definitions([fk_def], labels, { author_id: "2,5" }, {}, all_options);
		expect(result[0].checked_values).toEqual(["2", "5"]);
	});

	test("sets checked_values as single-element array for boolean", () => {
		const result = enrich_filter_definitions([bool_def], labels, { is_active: "1" }, {}, {});
		expect(result[0].checked_values).toEqual(["1"]);
	});

	test("sets checked_values as single-element array for text", () => {
		const result = enrich_filter_definitions([text_def], labels, { description: "hello" }, {}, {});
		expect(result[0].checked_values).toEqual(["hello"]);
	});

	test("sets empty checked_values when no filter param", () => {
		const result = enrich_filter_definitions([fk_def], labels, {}, {}, all_options);
		expect(result[0].checked_values).toEqual([]);
	});

	test("sets current_value from filter params", () => {
		const result = enrich_filter_definitions(
			[text_def],
			labels,
			{ description: "search term" },
			{},
			{},
		);
		expect(result[0].current_value).toBe("search term");
	});

	test("sets current_value to empty string when no filter param", () => {
		const result = enrich_filter_definitions([text_def], labels, {}, {}, {});
		expect(result[0].current_value).toBe("");
	});

	test("sets is_not from filter_not_params", () => {
		const result = enrich_filter_definitions([text_def], labels, {}, { description: "1" }, {});
		expect(result[0].is_not).toBe(true);
	});

	test("sets is_not false when no filter_not param", () => {
		const result = enrich_filter_definitions([text_def], labels, {}, {}, {});
		expect(result[0].is_not).toBe(false);
	});

	test("handles missing filter_options entry with empty arrays", () => {
		const result = enrich_filter_definitions([fk_def], labels, {}, {}, {});
		expect(result[0].visible_options).toEqual([]);
		expect(result[0].hidden_options).toEqual([]);
		expect(result[0].has_more).toBe(false);
	});

	test("preserves extra FilterDef fields (fk_table, fk_column)", () => {
		const result = enrich_filter_definitions([fk_def], labels, {}, {}, all_options);
		expect(result[0].fk_table).toBe("authors");
		expect(result[0].fk_column).toBe("id");
		expect(result[0].type).toBe("fk");
		expect(result[0].key).toBe("author_id");
	});

	test("returns empty array for empty input", () => {
		const result = enrich_filter_definitions([], labels, {}, {}, {});
		expect(result).toEqual([]);
	});

	test("handles multiple defs with mixed types", () => {
		const defs = [fk_def, bool_def, text_def];
		const result = enrich_filter_definitions(defs, labels, {
			author_id: "1",
			is_active: "1",
		}, { is_active: "1" }, all_options);
		expect(result).toHaveLength(3);

		// FK def
		expect(result[0].display_label).toBe("Author");
		expect(result[0].checked_values).toEqual(["1"]);
		expect(result[0].is_not).toBe(false);

		// Boolean def
		expect(result[1].display_label).toBe("Is Active");
		expect(result[1].checked_values).toEqual(["1"]);
		expect(result[1].is_not).toBe(true);

		// Text def (no param, no label translation)
		expect(result[2].display_label).toBe("Description");
		expect(result[2].checked_values).toEqual([]);
		expect(result[2].is_not).toBe(false);
	});
});
