import { describe, expect, test } from "bun:test";

import { build_translation_resolve_expr, DOTTED_PATH_RE } from "./translation_path";

describe("translation_path", () => {
	describe("build_translation_resolve_expr", () => {
		test("simple dotted path", () => expect(build_translation_resolve_expr("labels.text_input", "err")).toBe("(props.translations?.labels?.text_input ?? \"{text_input}\")"));

		test("single segment", () => expect(build_translation_resolve_expr("cancel", "err")).toBe("(props.translations?.cancel ?? \"{cancel}\")"));

		test("optional-chain segments are normalized", () => expect(build_translation_resolve_expr("ui?.title", "err")).toBe("(props.translations?.ui?.title ?? \"{title}\")"));

		test("string-literal bracket key", () => expect(build_translation_resolve_expr("selectors?.[\"0\"]", "err")).toBe("(props.translations?.selectors?.[\"0\"] ?? \"{0}\")"));

		test("trims surrounding whitespace", () => expect(build_translation_resolve_expr("  actions.save  ", "err")).toBe("(props.translations?.actions?.save ?? \"{save}\")"));

		test("rejects function calls", () => expect(() => build_translation_resolve_expr("labels.foo()", "err")).toThrow("err"));

		test("rejects arbitrary expressions", () => expect(() => build_translation_resolve_expr("a + b", "err")).toThrow());

		test("rejects computed keys", () => expect(() => build_translation_resolve_expr("labels[key]", "err")).toThrow());
	});

	describe("DOTTED_PATH_RE", () => {
		test("accepts plain identifiers and dots", () => expect(DOTTED_PATH_RE.test("a.b.c")).toBe(true));

		test("rejects trailing dot", () => expect(DOTTED_PATH_RE.test("a.b.")).toBe(false));
	});
});
