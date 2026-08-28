import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAIN_APP } from "$config/paths";

const i18n = await import("./i18n");

const project_dirs: string[] = [];

function create_project_dir(): string {
	const project_dir = mkdtempSync(join(tmpdir(), "reepolee-i18n-"));
	project_dirs.push(project_dir);
	mkdirSync(join(project_dir, MAIN_APP, "home"), { recursive: true });
	return project_dir;
}

function write_locale_file(project_dir: string, locale: string, obj: Record<string, any>): void {
	Bun.write(join(project_dir, MAIN_APP, "home", `${locale}.json`), JSON.stringify(obj) + "\n");
}

afterEach(() => {
	for (const project_dir of project_dirs.splice(0)) {
		rmSync(project_dir, { recursive: true, force: true });
	}
});

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

describe("i18n - cross-locale fallback", () => {
	// Reset singleton state before each test to prevent cross-test pollution
	beforeEach(() => i18n.translations.clear());

	test("empty-string translations survive the fallback untouched", async () => {
		const project_dir = create_project_dir();
		// Default locale owns the key with a real value; sl-si deliberately
		// sets an empty string (e.g. an empty unit suffix) - that is a valid
		// translation, not a missing one.
		write_locale_file(project_dir, "en-us", { unit: "mm" });
		write_locale_file(project_dir, "sl-si", { unit: "" });

		const loaded = await (i18n.translations as any).load_all_translations(["en-us", "sl-si"], project_dir);

		expect(loaded["en-us"].home.unit).toBe("mm");
		expect(loaded["sl-si"].home.unit).toBe("");
	});

	test("keys absent from the non-default locale still get the missing marker", async () => {
		const project_dir = create_project_dir();
		write_locale_file(project_dir, "en-us", { unit: "mm" });
		write_locale_file(project_dir, "sl-si", {});

		const loaded = await (i18n.translations as any).load_all_translations(["en-us", "sl-si"], project_dir);

		expect(loaded["en-us"].home.unit).toBe("mm");
		expect(loaded["sl-si"].home.unit).toBe("{unit}");
	});
});
