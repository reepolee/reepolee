import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { install_archived_translation_bundle, parse_and_validate_translation_bundle } from "./translation_bundle";

const FAKE_HASH = "a".repeat(64);

let project_dir = "";

beforeAll(async () => {
	// Minimal project fixture: one en-us source under the reeman app tree.
	project_dir = await mkdtemp(join(tmpdir(), "bundle-test-"));
	const en_us_file = join(project_dir, "apps/reeman/demo/locales/en-us.json");
	await mkdir(join(project_dir, "apps/reeman/demo/locales"), { recursive: true });
	await writeFile(en_us_file, `${JSON.stringify({ hello: "Hello", actions: { save: "Save" } }, null, "\t")}\n`);
});

afterAll(async () => {
	await rm(project_dir, { recursive: true, force: true });
});

const VALID_PATH = "apps/reeman/demo/locales/en-us.json";
const STALE_PATH = "apps/main/deleted-route/locales/en-us.json";

function stale_bundle(): Record<string, unknown> {
	return {
		format: "reepolee-translations-v1",
		source_locale: "en-us",
		target_locale: "zz-zz",
		files: {
			// Path with no current en-us source (route was deleted/renamed).
			[STALE_PATH]: { source_hash: FAKE_HASH, translations: { gone: "Weg" } },
			// Valid path whose translations carry a key that no longer exists
			// in the current en-us tree.
			[VALID_PATH]: {
				source_hash: FAKE_HASH,
				translations: { hello: "Hallo", stale_key: "Vergessen" },
			},
		},
	};
}

describe("parse_and_validate_translation_bundle", () => {
	test("strict mode rejects a bundle with a stale path (upload validation)", async () => {
		await expect(parse_and_validate_translation_bundle(stale_bundle(), project_dir)).rejects.toThrow(/is stale because no current English source/);
	});

	test("strict mode rejects stale keys inside a valid file", async () => {
		const bundle = stale_bundle();
		bundle.files = { [VALID_PATH]: { source_hash: FAKE_HASH, translations: { hello: "Hallo", stale_key: "Vergessen" } } };
		await expect(parse_and_validate_translation_bundle(bundle, project_dir)).rejects.toThrow(/does not exist in the current English source/);
	});

	test("lenient mode skips stale paths and copies remaining leaves as-is", async () => {
		const parsed = await parse_and_validate_translation_bundle(stale_bundle(), project_dir, { lenient: true });
		expect(Object.keys(parsed.files)).toEqual([VALID_PATH]);
		const file = parsed.files[VALID_PATH]!;
		// Leaves are copied unchanged - the stale key is the user's to fix.
		expect(file.translations).toEqual({ hello: "Hallo", stale_key: "Vergessen" });
		// The hash is re-stamped from the current en-us source, keeping the
		// archive freshness signal intact.
		expect(file.source_hash).not.toBe(FAKE_HASH);
		expect(file.source_hash).toMatch(/^[a-f0-9]{64}$/);
	});

	test("lenient mode still enforces structural integrity", async () => {
		const bundle = stale_bundle();
		bundle.files = { [VALID_PATH]: { source_hash: FAKE_HASH, translations: { hello: 42 } } };
		await expect(parse_and_validate_translation_bundle(bundle, project_dir, { lenient: true })).rejects.toThrow(/must be a string leaf/);
	});

	test("lenient mode rejects a bundle with nothing left to install", async () => {
		const bundle = stale_bundle();
		bundle.files = { [STALE_PATH]: { source_hash: FAKE_HASH, translations: { gone: "Weg" } } };
		await expect(parse_and_validate_translation_bundle(bundle, project_dir, { lenient: true })).rejects.toThrow(/must contain at least one file/);
	});
});

describe("install_archived_translation_bundle", () => {
	test("imports a stale archive without failing and writes only current paths", async () => {
		const archive_dir = join(project_dir, "locales-archive");
		await mkdir(archive_dir, { recursive: true });
		await writeFile(join(archive_dir, "zz-zz.json"), `${JSON.stringify(stale_bundle(), null, "\t")}\n`);

		const installed = await install_archived_translation_bundle("zz-zz", project_dir);
		expect(Object.keys(installed.files)).toEqual([VALID_PATH]);

		// The valid entry was copied to the correct live folder...
		const live_file = join(project_dir, "apps/reeman/demo/locales/zz-zz.json");
		expect(await Bun.file(live_file).exists()).toBe(true);
		expect(await Bun.file(live_file).json()).toEqual({ hello: "Hallo", stale_key: "Vergessen" });
		// ...and the stale route's file was not resurrected.
		expect(await Bun.file(join(project_dir, "apps/main/deleted-route/locales/zz-zz.json")).exists()).toBe(false);
	});
});
