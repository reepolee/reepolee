import { describe, expect, test } from "bun:test";

const ts = await import("./template_substitutor");

describe("template_substitutor - apply_template", () => {
	test("replaces single placeholder", () => {
		const result = ts.apply_template("Hello __name__!", { name: "World" });
		expect(result).toBe("Hello World!");
	});

	test("replaces multiple placeholders", () => {
		const result = ts.apply_template("__greeting__, __name__!", { greeting: "Hello", name: "World" });
		expect(result).toBe("Hello, World!");
	});

	test("replaces same placeholder in multiple places", () => {
		const result = ts.apply_template("__x__ + __x__ = __y__", { x: "1", y: "2" });
		expect(result).toBe("1 + 1 = 2");
	});

	test("handles empty string values", () => {
		const result = ts.apply_template("prefix__key__suffix", { key: "" });
		expect(result).toBe("prefixsuffix");
	});

	test("treats missing context key as unreplaced placeholder (warning)", () => {
		// Should produce a warning but still return with unreplaced placeholder
		const result = ts.apply_template("Hello __name__!", {});
		// __name__ should remain because there's no matching context key
		expect(result).toBe("Hello __name__!");
	});

	test("does not replace __key__ when key is not in context", () => {
		const result = ts.apply_template("__present__ __missing__", { present: "here" });
		expect(result).toBe("here __missing__");
	});

	test("handles dotted keys (table.exact, field.name, etc.)", () => {
		const result = ts.apply_template("Table: __table.exact__, Field: __field.name__", {
			"table.exact": "users",
			"field.name": "email",
		});
		expect(result).toBe("Table: users, Field: email");
	});

	test("replaces no placeholders when none in template", () => {
		const result = ts.apply_template("plain text with no placeholders", { key: "value" });
		expect(result).toBe("plain text with no placeholders");
	});

	test("does not interfere with double underscores not matching patterns", () => {
		const result = ts.apply_template("__not_a__placeholder", { not_a: "value" });
		expect(result).toBe("valueplaceholder");
	});
});

describe("template_substitutor - apply_template_detailed", () => {
	test("returns used, unused, and missing keys", () => {
		const { result, used, unused, missing } = ts.apply_template_detailed("__a__ __b__", {
			a: "1",
			b: "2",
			c: "3",
		});
		expect(result).toBe("1 2");
		expect(used).toEqual(["a", "b"]);
		expect(unused).toEqual(["c"]);
		expect(missing).toEqual([]);
	});

	test("detects missing placeholders", () => {
		const { result, used, unused, missing } = ts.apply_template_detailed("__a__ __missing__", { a: "1" });
		expect(result).toBe("1 __missing__");
		expect(used).toEqual(["a"]);
		expect(unused).toEqual([]);
		expect(missing).toEqual(["missing"]);
	});

	test("reports all unused keys", () => {
		const { used, unused } = ts.apply_template_detailed("__x__", {
			x: "X",
			extra1: "ignored",
			extra2: "ignored",
		});
		expect(used).toEqual(["x"]);
		expect(unused).toEqual(["extra1", "extra2"]);
	});

	test("returns empty arrays for empty template", () => {
		const { result, used, unused, missing } = ts.apply_template_detailed("", { a: "1" });
		expect(result).toBe("");
		expect(used).toEqual([]);
		expect(unused).toEqual(["a"]);
		expect(missing).toEqual([]);
	});

	test("handles overlapping placeholder names", () => {
		const { result, used } = ts.apply_template_detailed("__a__ __a.b__ __a.b.c__", {
			a: "1",
			"a.b": "2",
			"a.b.c": "3",
		});
		expect(result).toBe("1 2 3");
		expect(used).toEqual(["a", "a.b", "a.b.c"]);
	});
});
