import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { add_exact, has_exact, invalid_patterns, is_ignored, load_ignore_list, matching_glob, remove_exact } from "./ignore_list";

async function make_dir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
	const dir = await mkdtemp(join(tmpdir(), "reesync-ignore-"));
	return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe("ignore_list", () => {
	test("missing file yields an empty list", async () => {
		const { dir, cleanup } = await make_dir();
		try {
			const list = await load_ignore_list(dir);
			expect(is_ignored(list, "package.json")).toBe(false);
		} finally {
			await cleanup();
		}
	});

	test("matches exact and glob patterns, skips comments and blanks", async () => {
		const { dir, cleanup } = await make_dir();
		try {
			await writeFile(join(dir, ".reesyncignore"), "# comment\npackage.json\nsrc/css/**\n\n");
			const list = await load_ignore_list(dir);

			expect(is_ignored(list, "package.json")).toBe(true);
			expect(is_ignored(list, "src/css/style.css")).toBe(true);
			expect(is_ignored(list, "src/lib/helper.ts")).toBe(false);
		} finally {
			await cleanup();
		}
	});

	test("distinguishes exact lines from glob-matched files", async () => {
		const { dir, cleanup } = await make_dir();
		try {
			await writeFile(join(dir, ".reesyncignore"), "package.json\nsrc/css/**\n");
			const list = await load_ignore_list(dir);

			expect(has_exact(list, "package.json")).toBe(true);
			expect(matching_glob(list, "package.json")).toBe(null);

			expect(has_exact(list, "src/css/style.css")).toBe(false);
			expect(matching_glob(list, "src/css/style.css")).toBe("src/css/**");
		} finally {
			await cleanup();
		}
	});

	test("add/remove exact roundtrips through disk", async () => {
		const { dir, cleanup } = await make_dir();
		try {
			let list = await load_ignore_list(dir);
			list = await add_exact(list, "wrangler.jsonc");
			expect(is_ignored(list, "wrangler.jsonc")).toBe(true);

			const reloaded = await load_ignore_list(dir);
			expect(is_ignored(reloaded, "wrangler.jsonc")).toBe(true);

			const removed = await remove_exact(reloaded, "wrangler.jsonc");
			expect(is_ignored(removed, "wrangler.jsonc")).toBe(false);

			const reloaded_again = await load_ignore_list(dir);
			expect(is_ignored(reloaded_again, "wrangler.jsonc")).toBe(false);
		} finally {
			await cleanup();
		}
	});

	test("reports invalid glob patterns without throwing", async () => {
		const { dir, cleanup } = await make_dir();
		try {
			await writeFile(join(dir, ".reesyncignore"), "valid/**\n[unclosed\n");
			const list = await load_ignore_list(dir);
			expect(invalid_patterns(list)).toContain("[unclosed");
		} finally {
			await cleanup();
		}
	});
});
