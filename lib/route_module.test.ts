import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { route_namespace_from_dir } from "$lib/route";
import { get_route_module_mounts, mount_route_module, reset_route_module_mounts } from "$lib/route_module";
import { discover_static_dirs } from "$lib/static_discovery";

const temp_dirs: string[] = [];

afterEach(() => {
	reset_route_module_mounts();
	for (const temp_dir of temp_dirs) {
		if (existsSync(temp_dir)) { rmSync(temp_dir, { recursive: true, force: true }); }
	}
	temp_dirs.length = 0;
});

describe("mounted route modules", () => {
	test("loads handlers and resolves an external module namespace", async () => {
		const fixture = await make_module_fixture("export const route_definitions = [{ url: '/studio', handler: () => new Response('studio') }];\n");
		const route_definitions = await mount_route_module("studio", fixture.entry_url);
		const nested_dir = join(fixture.module_root, "lib");

		expect(route_definitions).toHaveLength(1);
		expect(route_namespace_from_dir(fixture.module_root)).toBe("studio");
		expect(route_namespace_from_dir(nested_dir)).toBe("studio/lib");
		expect(get_route_module_mounts()).toEqual([{ module_code: "studio", module_root: fixture.module_root }]);
	});

	test("adds mounted module static folders to application static discovery", async () => {
		const fixture = await make_module_fixture("export const route_definitions = [];\n");
		const module_static_dir = join(fixture.module_root, "static");
		mkdirSync(module_static_dir, { recursive: true });
		await Bun.write(join(module_static_dir, "studio.js"), "console.log('studio');\n");
		await mount_route_module("studio", fixture.entry_url);

		const static_dirs = discover_static_dirs(fixture.project_root);

		expect(static_dirs).toContain(module_static_dir);
	});

	test("fails loudly when route_definitions is missing", async () => {
		const fixture = await make_module_fixture("export const invalid = true;\n");
		const mount_result = mount_route_module("studio", fixture.entry_url);

		await expect(mount_result).rejects.toThrow("must export route_definitions");
	});

	test("rejects duplicate module codes", async () => {
		const first_fixture = await make_module_fixture("export const route_definitions = [];\n");
		const second_fixture = await make_module_fixture("export const route_definitions = [];\n");
		await mount_route_module("studio", first_fixture.entry_url);

		const duplicate_result = mount_route_module("studio", second_fixture.entry_url);

		await expect(duplicate_result).rejects.toThrow("already mounted");
	});
});

async function make_module_fixture(source: string): Promise<{ project_root: string; module_root: string; entry_url: string; }> {
	const project_root = mkdtempSync(join(tmpdir(), "reepolee-route-module-"));
	temp_dirs.push(project_root);
	const module_root = join(project_root, "marketplace", "studio");
	mkdirSync(join(module_root, "lib"), { recursive: true });
	const entry_path = join(module_root, "index.ts");
	await Bun.write(entry_path, source);
	const entry_url = pathToFileURL(entry_path).href;
	return { project_root, module_root, entry_url };
}
