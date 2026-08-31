import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { candidate_files, resolve_i18n_target } from "$lib/inspector_i18n_write";
import { MAIN_APP, REEMAN_APP } from "$config/paths";

let project_dir: string;

beforeAll(async () => {
	project_dir = mkdtempSync(join(tmpdir(), "reepolee-i18n-"));
	mkdirSync(join(project_dir, MAIN_APP, "home"), { recursive: true });
	mkdirSync(join(project_dir, REEMAN_APP), { recursive: true });
	await Bun.write(join(project_dir, "en-us.json"), JSON.stringify({ ui: { global: "Global" } }, null, "\t") + "\n");
	await Bun.write(join(project_dir, MAIN_APP, "home", "en-us.json"), JSON.stringify({ ui: { title: "Home" } }, null, "\t") + "\n");
});

afterAll(() => rmSync(project_dir, { recursive: true, force: true }));

describe("inspector translation file resolution", () => {
	test("checks the namespace file before root", () => {
		const files = candidate_files(project_dir, "home", "en-us");
		expect(files).toEqual([
			join(project_dir, MAIN_APP, "home", "en-us.json"),
			join(project_dir, "en-us.json"),
		]);
	});

	test("uses the namespace locales directory when present", async () => {
		const locales_dir = join(project_dir, MAIN_APP, "about", "locales");
		mkdirSync(locales_dir, { recursive: true });
		const locale_file = join(locales_dir, "sl-si.json");
		await Bun.write(locale_file, JSON.stringify({ ui: { title: "Domov" } }, null, "\t") + "\n");

		const files = candidate_files(project_dir, "about", "sl-si");
		expect(files[0]).toBe(locale_file);
	});

	test("resolves a namespaced key", async () => {
		const result = await resolve_i18n_target(project_dir, "home", "en-us", "ui.title");
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.current).toBe("Home");
	});

	test("falls back to the root file", async () => {
		const result = await resolve_i18n_target(project_dir, "home", "en-us", "ui.global");
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.file).toBe(join(project_dir, "en-us.json"));
	});

	test("rejects invalid dotted keys", async () => {
		const result = await resolve_i18n_target(project_dir, "home", "en-us", "ui.bad key");
		expect(result.ok).toBe(false);
	});
});
