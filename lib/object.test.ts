import { describe, expect, test } from "bun:test";

const obj = await import("./object");

describe("object - get_nested", () => {
	const data = { a: { b: { c: "deep" } }, x: "flat" };

	test("accesses deeply nested path with dot notation", () => expect(obj.get_nested(data, "a.b.c")).toBe("deep"));

	test("accesses deeply nested path with slash notation", () => expect(obj.get_nested(data, "a/b/c")).toBe("deep"));

	test("returns {} for undefined path", () => expect(obj.get_nested(data, "a.b.missing")).toEqual({}));

	test("returns {} for null obj", () => expect(obj.get_nested(null, "a.b")).toEqual({}));

	test("returns {} for empty path", () => expect(obj.get_nested(data, "")).toEqual({}));

	test("returns {} for missing root key", () => expect(obj.get_nested(data, "nonexistent")).toEqual({}));

	test("handles top-level keys", () => expect(obj.get_nested(data, "x")).toBe("flat"));
});

describe("object - deep_merge", () => {
	test("merges simple values", () => {
		const target = { a: 1, b: 2 };
		obj.deep_merge(target, { b: 3, c: 4 });
		expect(target).toEqual({ a: 1, b: 3, c: 4 });
	});

	test("deeply merges nested objects", () => {
		const target = { config: { theme: "dark", lang: "en" } };
		obj.deep_merge(target, { config: { lang: "sl", font: "large" } });
		expect(target).toEqual({ config: { theme: "dark", lang: "sl", font: "large" } });
	});

	test("overwrites arrays (not deep-merged)", () => {
		const target = { items: [1, 2, 3] };
		obj.deep_merge(target, { items: [4, 5] });
		expect(target.items).toEqual([4, 5]);
	});

	test("handles null source", () => {
		const target = { a: 1 };
		obj.deep_merge(target, null as any);
		expect(target).toEqual({ a: 1 });
	});

	test("handles undefined source", () => {
		const target = { a: 1 };
		obj.deep_merge(target, undefined as any);
		expect(target).toEqual({ a: 1 });
	});

	test("adds new nested objects", () => {
		const target: any = {};
		obj.deep_merge(target, { nested: { key: "value" } });
		expect(target).toEqual({ nested: { key: "value" } });
	});
});

describe("object - merge_fields", () => {
	test("merges generated fields with overrides", () => {
		const generated = {
			name: { type: "text" as const, name: "name", attributes: { required: true, max_length: 100 } },
		};
		const overrides = { name: { attributes: { max_length: 200 } } };
		const result = obj.merge_fields(generated, overrides);
		expect(result.name.attributes.required).toBe(true); // from generated
		expect(result.name.attributes.max_length).toBe(200); // from override
	});

	test("returns generated fields unchanged when no overrides", () => {
		const generated = { name: { type: "text" as const, name: "name", attributes: {} } };
		const result = obj.merge_fields(generated, {});
		expect(result).toEqual(generated);
	});
});

describe("object - updated_diff", () => {
	test("returns only changed keys", () => {
		const original = { name: "Alice", email: "a@b.com", age: 30 };
		const updated = { name: "Bob", email: "a@b.com", age: 31 };
		expect(obj.updated_diff(original, updated)).toEqual({ name: "Bob", age: 31 });
	});

	test("returns empty when nothing changed", () => {
		const obj_data = { a: 1, b: 2 };
		expect(obj.updated_diff(obj_data, { ...obj_data })).toEqual({});
	});

	test("detects added keys", () => {
		const original = { a: 1 };
		const updated = { a: 1, b: 2 };
		expect(obj.updated_diff(original, updated)).toEqual({ b: 2 });
	});

	test("detects removed keys (value becomes undefined)", () => {
		const original = { a: 1, b: 2 } as Record<string, unknown>;
		const updated = { a: 1 } as Record<string, unknown>;
		// b is now undefined, which differs from original 2
		const diff = obj.updated_diff(original, updated);
		expect(diff).toEqual({ b: undefined });
	});
});

describe("object - read_json", () => {
	test("returns {} for non-existent file", () => expect(obj.read_json("/tmp/nonexistent_file_xyz.json")).toEqual({}));

	test("parses valid JSON file", async () => {
		const { writeFileSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const tmp = join(tmpdir(), `test_read_json_${Date.now()}.json`);
		writeFileSync(tmp, JSON.stringify({ hello: "world" }));
		try {
			expect(obj.read_json(tmp)).toEqual({ hello: "world" });
		} finally {
			rmSync(tmp);
		}
	});

	test("returns {} for malformed JSON", async () => {
		const { writeFileSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const tmp = join(tmpdir(), `test_bad_json_${Date.now()}.json`);
		writeFileSync(tmp, "not valid json");
		try {
			expect(obj.read_json(tmp)).toEqual({});
		} finally {
			rmSync(tmp);
		}
	});
});
