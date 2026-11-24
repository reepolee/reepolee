import { describe, expect, test } from "bun:test";

import { feature_paths, is_list_return_url } from "./crud_routes";

describe("feature_paths", () => {
	test("builds list and entity paths without a prefix", () => {
		const { base_path, entity_path } = feature_paths("", "products");
		expect(base_path()).toBe("/products");
		expect(entity_path(1)).toBe("/products/1/edit");
		expect(entity_path()).toBe("/products");
	});

	test("builds paths under a route prefix", () => {
		const { base_path, entity_path } = feature_paths("/system", "users");
		expect(base_path()).toBe("/system/users");
		expect(entity_path(5)).toBe("/system/users/5/edit");
	});
});

describe("is_list_return_url", () => {
	test("accepts the list path", () => {
		expect(is_list_return_url("/products", "/products")).toBe(true);
		expect(is_list_return_url("/products/", "/products")).toBe(true);
	});

	test("accepts the list path with its filter and pagination query", () => {
		expect(is_list_return_url("/products?offset=20&sort=name", "/products")).toBe(true);
	});

	test("rejects an entity page", () => {
		// The return URL is captured from document.referrer, so any flow that
		// reloads the edit page - a save, or a copy between locales - makes the
		// edit page its own referrer. Honouring it sends "save & close" straight
		// back into the form the user asked to leave.
		expect(is_list_return_url("/products/2/edit", "/products")).toBe(false);
		expect(is_list_return_url("/products/2/edit?x=1", "/products")).toBe(false);
	});

	test("rejects a different feature that merely shares a prefix", () => {
		expect(is_list_return_url("/products-archive", "/products")).toBe(false);
	});

	test("rejects empty and missing values", () => {
		expect(is_list_return_url("", "/products")).toBe(false);
		expect(is_list_return_url(null, "/products")).toBe(false);
		expect(is_list_return_url(undefined, "/products")).toBe(false);
	});

	test("works under a route prefix", () => {
		expect(is_list_return_url("/system/users?page=2", "/system/users")).toBe(true);
		expect(is_list_return_url("/system/users/5/edit", "/system/users")).toBe(false);
	});
});
