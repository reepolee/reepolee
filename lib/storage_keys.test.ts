import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { normalize_storage_folder, normalize_storage_key, resolve_local_storage_path } from "./storage_keys";

describe("storage keys", () => {
	test("accepts normalized nested folders", () => {
		expect(normalize_storage_folder("projects/2026/launch")).toBe("projects/2026/launch");
	});

	test("rejects unsafe folder paths", () => {
		for (const folder of ["../outside", "/absolute", "nested\\windows", "nested//empty", "./current", "nested/../outside", "nested/\0null"]) {
			expect(() => normalize_storage_folder(folder)).toThrow();
		}
	});

	test("resolves a normalized key inside the image bucket", () => {
		const root = join("/tmp", "reepolee-storage");
		const resolved = resolve_local_storage_path(root, "images", "projects/2026/image.webp");

		expect(resolved).toBe(join(root, "images", "projects", "2026", "image.webp"));
	});

	test("rejects keys that would escape the bucket", () => {
		const root = join("/tmp", "reepolee-storage");

		expect(() => resolve_local_storage_path(root, "images", "../outside.webp")).toThrow();
	});

	test("rejects unsafe direct storage keys", () => {
		for (const storage_key of ["/absolute.webp", "C:/absolute.webp", "nested\\windows.webp", "nested/../outside.webp"]) {
			expect(() => normalize_storage_key(storage_key)).toThrow();
		}
	});
});
