import { expect, test } from "bun:test";

import { deepl_language_code } from "./deepl";

test("resolves locale codes to DeepL language codes", () => {
	expect(deepl_language_code("de-de", true)).toBe("DE");
	expect(deepl_language_code("sl-si", true)).toBe("SL");
	expect(deepl_language_code("hr-hr", true)).toBe("HR");
	expect(deepl_language_code("it", true)).toBe("IT");
});

test("keeps the region only for English targets (DeepL requires EN-XX)", () => {
	expect(deepl_language_code("en-us", true)).toBe("EN-US");
	expect(deepl_language_code("en-us", false)).toBe("EN");
});

test("accepts a bare language code as source or target", () => {
	expect(deepl_language_code("de", false)).toBe("DE");
	expect(deepl_language_code("hr", true)).toBe("HR");
});

test("rejects display names - callers must pass locale codes", () => {
	expect(() => deepl_language_code("German", true)).toThrow(/German/);
	expect(() => deepl_language_code("German (Germany)", true)).toThrow(/German/);
	expect(() => deepl_language_code("Croatian (Croatia)", true)).toThrow(/Croatian/);
	expect(() => deepl_language_code("Slovenščina", true)).toThrow(/Slovenščina/);
});
