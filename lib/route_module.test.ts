import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { route_namespace_from_dir } from "$lib/route";
import { get_route_module_mounts, mount_route_module, mount_route_modules_from_dir, reset_route_module_mounts, resolve_route_module_template_namespace } from "$lib/route_module";
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

	test("applies an app namespace prefix to mounted route modules", async () => {
		const fixture = await make_module_fixture("export const route_definitions = [];\n");
		await mount_route_module("users", fixture.entry_url, "reeman");

		expect(route_namespace_from_dir(fixture.module_root)).toBe("reeman/users");
		expect(route_namespace_from_dir(join(fixture.module_root, "lib"))).toBe("reeman/users/lib");
		expect(resolve_route_module_template_namespace(fixture.module_root)).toBe("reeman/users");
		expect(resolve_route_module_template_namespace(join(fixture.module_root, "lib"))).toBe("reeman/users/lib");
		expect(get_route_module_mounts()).toEqual([{
			module_code: "users",
			module_root: fixture.module_root,
			namespace_prefix: "reeman",
		}]);
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

	test("mount_route_modules_from_dir mounts every first-level module folder by default", async () => {
		const project_root = mkdtempSync(join(tmpdir(), "reepolee-route-module-"));
		temp_dirs.push(project_root);

		const mk_entry = async (rel: string, source: string): Promise<void> => {
			const entry_path = join(project_root, rel);
			mkdirSync(dirname(entry_path), { recursive: true });
			await Bun.write(entry_path, source);
		};

		await mk_entry("users/index.ts", "export const route_definitions = [{ url: '/system/users', nav_title_key: 'users', module: 'system' }];\n");
		await mk_entry("reeman/index.ts", "export const route_definitions = [{ url: '/reeman', nav_title_key: 'reeman.dashboard', module: 'system' }];\n");

		// Folders without an index.ts and stray top-level files are ignored.
		mkdirSync(join(project_root, "static"), { recursive: true });
		await Bun.write(join(project_root, "notes.ts"), "export const x = 1;\n");

		const definitions = await mount_route_modules_from_dir(project_root);

		// readdirSync order is alphabetical (reeman before users)
		expect(definitions.map((d) => d.url)).toEqual(["/reeman", "/system/users"]);
		expect(get_route_module_mounts()).toEqual([
			{ module_code: "reeman", module_root: join(project_root, "reeman") },
			{ module_code: "users", module_root: join(project_root, "users") },
		]);
		// Namespaces resolve under the folder names (flat model for first-party app folders).
		expect(route_namespace_from_dir(join(project_root, "users"))).toBe("users");
		expect(route_namespace_from_dir(join(project_root, "reeman"))).toBe("reeman");
		expect(route_namespace_from_dir(join(project_root, "reeman", "db_tables"))).toBe("reeman/db_tables");
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
