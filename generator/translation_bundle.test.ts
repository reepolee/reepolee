import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apply_route_translation_memory, install_archived_translation_bundle, read_translation_archive, save_route_translation_memory } from "./translation_bundle";

let project_dir = "";
const source = { actions: { save: "Save {count}" } };
const source_path = "apps/main/recipes/en-us.json";

beforeAll(async () => {
	project_dir = await mkdtemp(join(tmpdir(), "translation-archive-test-"));
	await mkdir(join(project_dir, "apps/main/recipes"), { recursive: true });
	await writeFile(join(project_dir, source_path), `${JSON.stringify(source)}\n`);
});

afterAll(async () => { await rm(project_dir, { recursive: true, force: true }); });

describe("translation archive v2", () => {
	test("stores route translations as source-validated leaves", async () => {
		await save_route_translation_memory(source_path, "zz-zz", source, { actions: { save: "Shrani {count}" } }, project_dir);
		const archive = await read_translation_archive("zz-zz", project_dir);
		expect(archive.format).toBe("reepolee-translations-v2");
		expect(archive.routes[source_path]?.["actions.save"]?.translation).toBe("Shrani {count}");
		const restored = await apply_route_translation_memory(source_path, "zz-zz", source, { actions: { save: "::missing:: Save {count}" } }, project_dir);
		expect(restored).toEqual({ actions: { save: "Shrani {count}" } });
	});

	test("installs route entries without using table memory", async () => {
		await install_archived_translation_bundle("zz-zz", project_dir);
		expect(await Bun.file(join(project_dir, "apps/main/recipes/zz-zz.json")).json()).toEqual({ actions: { save: "Shrani {count}" } });
	});
});
