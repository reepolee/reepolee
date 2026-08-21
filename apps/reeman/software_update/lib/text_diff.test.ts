import { describe, expect, test } from "bun:test";

import { build_diff, build_preview, looks_binary, MAX_DIFF_LINES } from "./text_diff";

const enc = new TextEncoder();

describe("text_diff", () => {
	test("detects additions, removals, and unchanged context", () => {
		const dest = enc.encode("a\nb\nc\n");
		const source = enc.encode("a\nx\nc\n");
		const result = build_diff(dest, source);
		expect(result.kind).toBe("diff");
		if (result.kind !== "diff") return;
		const flat = result.hunks.flatMap((h) => h.lines);
		expect(flat.some((l) => l.kind === "remove" && l.text === "b")).toBe(true);
		expect(flat.some((l) => l.kind === "add" && l.text === "x")).toBe(true);
		expect(flat.some((l) => l.kind === "same" && l.text === "a")).toBe(true);
	});

	test("empty files diff cleanly", () => {
		const result = build_diff(enc.encode(""), enc.encode(""));
		expect(result.kind).toBe("diff");
	});

	test("detects binary content via embedded NUL byte", () => {
		const bytes = new Uint8Array([104, 101, 0, 108, 108, 111]);
		expect(looks_binary(bytes)).toBe(true);
		expect(build_diff(bytes, enc.encode("x")).kind).toBe("binary");
	});

	test("refuses oversized text input", () => {
		const many_lines = new Array(MAX_DIFF_LINES + 10).fill("line").join("\n");
		const result = build_preview(enc.encode(many_lines));
		expect(result.kind).toBe("too-large");
	});

	test("new-file preview returns raw lines", () => {
		const result = build_preview(enc.encode("one\ntwo\n"));
		expect(result.kind).toBe("preview");
		if (result.kind !== "preview") return;
		expect(result.lines).toEqual(["one", "two", ""]);
	});
});
