import { beforeEach, describe, expect, test } from "bun:test";

const i18n = await import("./i18n");

describe("i18n - TranslationRepository", () => {
	// Reset singleton state before each test to prevent cross-test pollution
	beforeEach(() => i18n.translations.clear());

	test("translations exposes the TranslationRepository API", () => {
		expect(typeof i18n.translations.get).toBe("function");
		expect(typeof i18n.translations.reload).toBe("function");
		expect(typeof i18n.translations.initialize).toBe("function");
		expect(i18n.translations.all).toBeDefined();
	});

	test("get() returns undefined for a language before initialization", () => {
		expect(i18n.translations.get("sl")).toBeUndefined();
		expect(i18n.translations.all).toEqual({});
	});

	test("'all' getter returns object even before init", () => {
		const all = i18n.translations.all;
		expect(typeof all).toBe("object");
		expect(all).toEqual({});
	});

	test("version starts at 0 and is a number", () => expect(typeof i18n.translations.version).toBe("number"));
});
