import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";

import { MAIN_APP, REEMAN_APP, REEQA_APP } from "$config/paths";
import {
	list_locale_translation_files,
	list_shadowed_translation_files,
	list_translation_files,
	read_namespace_file,
	translation_file,
	upsert_file_translation,
} from "$lib/translation_files";

const project_dirs: string[] = [];

function create_project_dir(): string {
	const project_dir = mkdtempSync(join(tmpdir(), "reepolee-translation-files-"));
	project_dirs.push(project_dir);
	mkdirSync(join(project_dir, MAIN_APP, "home"), { recursive: true });
	mkdirSync(join(project_dir, REEMAN_APP), { recursive: true });
	mkdirSync(join(project_dir, REEQA_APP), { recursive: true });
	return project_dir;
}

afterEach(() => {
	for (const project_dir of project_dirs.splice(0)) {
		rmSync(project_dir, { recursive: true, force: true });
	}
});

describe("translation file layouts", () => {
	test("uses a namespace locales directory when present", async () => {
		const project_dir = create_project_dir();
		const locales_dir = join(project_dir, MAIN_APP, "home", "locales");
		mkdirSync(locales_dir);
		const locale_file = join(locales_dir, "en-us.json");
		await Bun.write(locale_file, JSON.stringify({ ui: { title: "Home" } }) + "\n");

		expect(translation_file("home", "en-us", project_dir)).toBe(locale_file);
		expect(await read_namespace_file("home", "en-us", project_dir)).toEqual({ ui: { title: "Home" } });

		await upsert_file_translation("en-us", "home", "ui.subtitle", "Welcome", project_dir);
		const updated = await Bun.file(locale_file).json();
		expect(updated).toEqual({ ui: { subtitle: "Welcome", title: "Home" } });
		expect(existsSync(join(project_dir, MAIN_APP, "home", "en-us.json"))).toBe(false);
	});

	test("keeps adjacent locale files for compact namespaces", async () => {
		const project_dir = create_project_dir();
		const locale_file = join(project_dir, MAIN_APP, "home", "en-us.json");
		await Bun.write(locale_file, JSON.stringify({ ui: { title: "Home" } }) + "\n");

		expect(translation_file("home", "en-us", project_dir)).toBe(locale_file);
		expect(await read_namespace_file("home", "en-us", project_dir)).toEqual({ ui: { title: "Home" } });
	});

	test("lists locales directories under their parent namespace", async () => {
		const project_dir = create_project_dir();
		const locales_dir = join(project_dir, MAIN_APP, "home", "locales");
		mkdirSync(locales_dir);
		const locale_file = join(locales_dir, "sl-si.json");
		await Bun.write(locale_file, "{}\n");

		const files = await list_translation_files(project_dir);
		expect(files).toContainEqual({ file: locale_file, locale: "sl-si", namespace: "home" });
	});

	test("maps the ReeQA root to its own namespace", async () => {
		const project_dir = create_project_dir();
		const locale_file = join(project_dir, REEQA_APP, "en-us.json");
		await Bun.write(locale_file, JSON.stringify({ nav_prefix_title: "ReeQA" }) + "\n");

		expect(translation_file("reeqa", "en-us", project_dir)).toBe(locale_file);
		const files = await list_translation_files(project_dir);
		expect(files).toContainEqual({ file: locale_file, locale: "en-us", namespace: "reeqa" });
	});

	test("supports a root locales directory", async () => {
		const project_dir = create_project_dir();
		const locales_dir = join(project_dir, "locales");
		mkdirSync(locales_dir);
		const locale_file = join(locales_dir, "en-us.json");
		await Bun.write(locale_file, JSON.stringify({ ui: { title: "Site" } }) + "\n");

		expect(translation_file("root", "en-us", project_dir)).toBe(locale_file);
		const files = await list_translation_files(project_dir);
		expect(files).toContainEqual({ file: locale_file, locale: "en-us", namespace: "root" });
	});

	test("supports a namespace named locales", async () => {
		const project_dir = create_project_dir();
		const namespace_dir = join(project_dir, MAIN_APP, "locales");
		const locales_dir = join(namespace_dir, "locales");
		mkdirSync(locales_dir, { recursive: true });
		await Bun.write(join(namespace_dir, "index.ree"), "<main></main>\n");
		const locale_file = join(locales_dir, "en-us.json");
		await Bun.write(locale_file, "{}\n");

		const files = await list_translation_files(project_dir);
		expect(files).toContainEqual({ file: locale_file, locale: "en-us", namespace: "locales" });
	});

	test("keeps adjacent files for a legacy namespace named locales", async () => {
		const project_dir = create_project_dir();
		const namespace_dir = join(project_dir, MAIN_APP, "locales");
		mkdirSync(namespace_dir);
		await Bun.write(join(namespace_dir, "index.ree"), "<main></main>\n");
		const locale_file = join(namespace_dir, "en-us.json");
		await Bun.write(locale_file, "{}\n");

		const files = await list_translation_files(project_dir);
		expect(files).toContainEqual({ file: locale_file, locale: "en-us", namespace: "locales" });
	});

	test("rejects duplicate adjacent and locales directory files", async () => {
		const project_dir = create_project_dir();
		const namespace_dir = join(project_dir, MAIN_APP, "home");
		mkdirSync(join(namespace_dir, "locales"));
		await Bun.write(join(namespace_dir, "en-us.json"), "{}\n");
		await Bun.write(join(namespace_dir, "locales", "en-us.json"), "{}\n");

		expect(() => translation_file("home", "en-us", project_dir)).toThrow("Duplicate translation files");
		expect(list_translation_files(project_dir)).rejects.toThrow("Duplicate translation files");
	});

	// list_locale_translation_files deliberately matches by filename so a removal
	// can still delete every on-disk file for a locale even when a namespace has a
	// duplicate pair (adjacent + locales/ subdir file) that list_translation_files
	// treats as fatal.
	test("lists every on-disk file for a locale including duplicate pairs", async () => {
		const project_dir = create_project_dir();

		// Namespace with a duplicate pair - fatal for list_translation_files.
		const namespace_dir = join(project_dir, MAIN_APP, "home");
		mkdirSync(join(namespace_dir, "locales"));
		const adjacent = join(namespace_dir, "sl-si.json");
		const nested = join(namespace_dir, "locales", "sl-si.json");
		await Bun.write(adjacent, "{}\n");
		await Bun.write(nested, "{}\n");

		// A normal per-route file plus the project root file.
		const other_route = join(project_dir, MAIN_APP, "modules", "locales", "sl-si.json");
		mkdirSync(dirname(other_route), { recursive: true });
		await Bun.write(other_route, "{}\n");
		const root_file = join(project_dir, "sl-si.json");
		await Bun.write(root_file, "{}\n");

		// The unfiltered scan aborts, but the tolerant locator still works.
		expect(list_translation_files(project_dir)).rejects.toThrow("Duplicate translation files");

		const files = await list_locale_translation_files("sl-si", project_dir);
		const relative_files = files.map((path) => relative(project_dir, path).split(sep).join("/")).sort();
		expect(relative_files).toEqual([
			"apps/main/home/locales/sl-si.json",
			"apps/main/home/sl-si.json",
			"apps/main/modules/locales/sl-si.json",
			"sl-si.json",
		].sort());

		// Other locales are not matched.
		expect(await list_locale_translation_files("en-us", project_dir)).toEqual([]);
	});

	test("keeps app translation namespaces independent", async () => {
		const project_dir = create_project_dir();
		const main_file = join(project_dir, MAIN_APP, "modules", "sl-si.json");
		const reeman_file = join(project_dir, REEMAN_APP, "modules", "locales", "sl-si.json");
		const reeqa_file = join(project_dir, REEQA_APP, "modules", "locales", "sl-si.json");
		mkdirSync(dirname(main_file), { recursive: true });
		mkdirSync(dirname(reeman_file), { recursive: true });
		mkdirSync(dirname(reeqa_file), { recursive: true });
		await Bun.write(main_file, JSON.stringify({ ui: { title: "Main modules" } }) + "\n");
		await Bun.write(reeman_file, JSON.stringify({ ui: { title: "Admin modules" } }) + "\n");
		await Bun.write(reeqa_file, JSON.stringify({ ui: { title: "QA modules" } }) + "\n");

		expect(translation_file("modules", "sl-si", project_dir)).toBe(main_file);
		expect(translation_file("reeman.modules", "sl-si", project_dir)).toBe(reeman_file);
		expect(translation_file("reeqa.modules", "sl-si", project_dir)).toBe(reeqa_file);

		const files = await list_translation_files(project_dir);
		expect(files).toContainEqual({ file: main_file, locale: "sl-si", namespace: "modules" });
		expect(files).toContainEqual({ file: reeman_file, locale: "sl-si", namespace: "reeman.modules" });
		expect(files).toContainEqual({ file: reeqa_file, locale: "sl-si", namespace: "reeqa.modules" });
		expect(await list_shadowed_translation_files(project_dir)).toEqual([]);
	});

	test("reports no shadowed files when every namespace is unambiguous", async () => {
		const project_dir = create_project_dir();
		const locale_file = join(project_dir, MAIN_APP, "home", "locales", "en-us.json");
		mkdirSync(dirname(locale_file), { recursive: true });
		await Bun.write(locale_file, "{}\n");

		expect(await list_shadowed_translation_files(project_dir)).toEqual([]);
	});

	test("reeman locale files use the reeman namespace", async () => {
		const project_dir = create_project_dir();
		const reeman_file = join(project_dir, REEMAN_APP, "modules", "locales", "en-us.json");
		mkdirSync(dirname(reeman_file), { recursive: true });
		await Bun.write(reeman_file, JSON.stringify({ ui: { title: "Modules" } }) + "\n");

		expect(translation_file("reeman.modules", "en-us", project_dir)).toBe(reeman_file);

		const files = await list_translation_files(project_dir);
		expect(files).toContainEqual({ file: reeman_file, locale: "en-us", namespace: "reeman.modules" });
	});
});
