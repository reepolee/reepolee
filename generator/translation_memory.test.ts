import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apply_translation_memory, save_translation_memory, snapshot_route_translation_memory } from "./translation_memory";

let project_dir = "";

beforeAll(async () => {
	project_dir = await mkdtemp(join(tmpdir(), "translation-memory-test-"));
});

afterAll(async () => {
	await rm(project_dir, { recursive: true, force: true });
});

describe("translation memory", () => {
	test("reuses only matching source strings and placeholders", async () => {
		const source = { actions: { save: "Save {count}" } };
		const translated = { actions: { save: "Shrani {count}" } };
		const missing = { actions: { save: "::missing:: Save {count}" } };
		await save_translation_memory("recipes", "sl-si", source, translated, project_dir);

		const reused = await apply_translation_memory("recipes", "sl-si", source, missing, project_dir);
		expect(reused).toEqual(translated);

		const changed_source = { actions: { save: "Save {total}" } };
		const not_reused = await apply_translation_memory("recipes", "sl-si", changed_source, { actions: { save: "::missing:: Save {total}" } }, project_dir);
		expect(not_reused).toEqual({ actions: { save: "::missing:: Save {total}" } });

		await save_translation_memory("recipes", "sl-si", { actions: { cancel: "Cancel {count}" } }, { actions: { cancel: "Prekliči" } }, project_dir);
		const incompatible_translation = await apply_translation_memory(
			"recipes",
			"sl-si",
			{ actions: { cancel: "Cancel {count}" } },
			{ actions: { cancel: "::missing:: Cancel {count}" } },
			project_dir,
		);
		expect(incompatible_translation).toEqual({ actions: { cancel: "::missing:: Cancel {count}" } });
	});

	test("snapshots human translations from a generated route", async () => {
		const route_dir = join(project_dir, "apps/main/ingredients");
		await mkdir(route_dir, { recursive: true });
		await writeFile(join(route_dir, "sql.ts"), 'export const TABLE_NAME = "ingredients";\n');
		await writeFile(join(route_dir, "en-us.json"), '{\n\t"title": "Ingredients"\n}\n');
		await writeFile(join(route_dir, "sl-si.json"), '{\n\t"title": "Sestavine"\n}\n');

		await snapshot_route_translation_memory(route_dir, project_dir);

		const reused = await apply_translation_memory(
			"ingredients",
			"sl-si",
			{ title: "Ingredients" },
			{ title: "::missing:: Ingredients" },
			project_dir,
		);
		expect(reused).toEqual({ title: "Sestavine" });
	});
});
