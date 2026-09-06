import { describe, expect, test } from "bun:test";

import { resolve_include, resolve_layout } from "./include_resolver";

const views_dir = "/project/routes";

describe("resolve_include", () => {
	test("rejects a template include that escapes the views directory", () => {
		expect(() => resolve_include("pages/home", "../../secret", views_dir, ".ree")).toThrow("Include path escapes base directory");
	});

	test("rejects an alias include that escapes the project directory", () => {
		expect(() => resolve_include("pages/home", "$components/../../secret", views_dir, ".ree")).toThrow("Include path escapes base directory");
	});

	test("does not mistake a sibling with a shared prefix for a child directory", () => {
		expect(() => resolve_include("pages/home", "../../routes-other/secret.txt", views_dir, ".ree")).toThrow("Include path escapes base directory");
	});

	test("keeps a relative template include inside the views directory", () => {
		const result = resolve_include("pages/home", "../shared/card", views_dir, ".ree");
		expect(result).toEqual({ kind: "template", template_name: "shared/card" });
	});
});

describe("resolve_layout", () => {
	// Layout names are never extension-sniffed: ".layout" in "docs.layout" is a
	// naming convention, not a file extension.
	const no_files = () => false;
	const co_located_only = (file_path: string) => file_path.replace(/\\/g, "/").endsWith("/pages/wallpaper.layout.ree");

	test("keeps a dotted convention name intact instead of reading it as an extension", () => {
		expect(resolve_layout("pages/home", "docs.layout", views_dir, ".ree", no_files)).toBe("docs.layout");
	});

	test("falls back to the views root when no co-located layout exists", () => {
		expect(resolve_layout("pages/home", "layout", views_dir, ".ree", no_files)).toBe("layout");
	});

	test("prefers a co-located layout over the views root", () => {
		expect(resolve_layout("pages/home", "wallpaper.layout", views_dir, ".ree", co_located_only)).toBe("pages/wallpaper.layout");
	});

	test("resolves an explicitly relative layout against the page directory", () => {
		expect(resolve_layout("pages/home", "./wallpaper.layout", views_dir, ".ree", no_files)).toBe("pages/wallpaper.layout");
	});

	test("treats a root-level page as living at the views root", () => {
		expect(resolve_layout("index", "layout", views_dir, ".ree", no_files)).toBe("layout");
	});

	test("treats render_string (empty current name) as the views root", () => {
		expect(resolve_layout("", "layout", views_dir, ".ree", no_files)).toBe("layout");
	});

	test("rejects a layout that escapes the views directory", () => {
		expect(() => resolve_layout("pages/home", "../../secret.layout", views_dir, ".ree", no_files)).toThrow("Include path escapes base directory");
	});
});
