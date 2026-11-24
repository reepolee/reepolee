import { describe, expect, test } from "bun:test";

import { resolve_global_scope_list_filter } from "./sql";

describe("global scope list filter", () => {
	test("defaults invalid values to user-created filters", () => {
		expect(resolve_global_scope_list_filter("")).toBe("user");
		expect(resolve_global_scope_list_filter("archive")).toBe("user");
		expect(resolve_global_scope_list_filter("all")).toBe("all");
	});
});
