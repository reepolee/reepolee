import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discover_routes_with_schema } from "./route_scan";

const temp_dirs: string[] = [];

async function create_routes_root(): Promise<string> {
	const routes_root = await mkdtemp(join(tmpdir(), "reepolee-route-scan-"));
	temp_dirs.push(routes_root);
	return routes_root;
}

afterEach(async () => {
	for (const temp_dir of temp_dirs.splice(0)) await rm(temp_dir, { recursive: true, force: true });
});

describe("discover_routes_with_schema", () => {
	test("discovers flat top-level, prefixed, and nested CRUD configurations", async () => {
		const routes_root = await create_routes_root();
		const route_dirs = [
			join(routes_root, "users"),
			join(routes_root, "admin", "projects"),
			join(routes_root, "orders", "items"),
		];
		for (const route_dir of route_dirs) {
			await mkdir(route_dir, { recursive: true });
			await Bun.write(join(route_dir, "config.ts"), "export const columns = {};\n");
		}
		await Bun.write(join(routes_root, "orders", "config.ts"), "export const columns = {};\n");

		const routes = discover_routes_with_schema(routes_root);
		const urls = routes.map((route) => route.url);

		expect(urls).toEqual(["/admin/projects", "/orders", "/orders/items", "/users"]);
		expect(routes.find((route) => route.url === "/orders/items")?.parent).toBe("orders");
	});

	test("does not treat a legacy schema directory as a configured CRUD route", async () => {
		const routes_root = await create_routes_root();
		const route_dir = join(routes_root, "legacy");
		await mkdir(join(route_dir, "schema"), { recursive: true });
		await Bun.write(join(route_dir, "schema", "table.ts"), "export const columns = {};\n");

		expect(discover_routes_with_schema(routes_root)).toEqual([]);
	});
});
