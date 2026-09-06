import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { migrate_route_schema } from "./migrate_route_schemas";

const temp_dirs: string[] = [];

async function create_route(): Promise<string> {
	const temp_dir = await mkdtemp(join(tmpdir(), "reepolee-route-schema-"));
	temp_dirs.push(temp_dir);
	const route_dir = join(temp_dir, "items");
	await mkdir(join(route_dir, "schema"), { recursive: true });
	return route_dir;
}

afterEach(async () => {
	for (const temp_dir of temp_dirs.splice(0)) await rm(temp_dir, { recursive: true, force: true });
});

describe("migrate_route_schema", () => {
	test("moves a complete legacy schema into the flat route layout", async () => {
		const route_dir = await create_route();
		await Bun.write(join(route_dir, "schema", "table.ts"), 'export { fields } from "./table.generated";\n');
		await Bun.write(join(route_dir, "schema", "table.generated.ts"), "export const fields = {};\n");
		await Bun.write(join(route_dir, "schema", "validation_server.ts"), "export const validate = () => true;\n");

		const result = await migrate_route_schema(route_dir);

		expect(result.moved).toEqual(["config.ts", "schema.generated.ts", "validation_server.ts"]);
		expect(await Bun.file(join(route_dir, "config.ts")).text()).toContain('from "./schema.generated"');
		expect(await Bun.file(join(route_dir, "schema.generated.ts")).exists()).toBe(true);
		expect(await Bun.file(join(route_dir, "validation_server.ts")).exists()).toBe(true);
		expect(await Bun.file(join(route_dir, "schema")).exists()).toBe(false);
	});

	test("finishes a partially migrated route", async () => {
		const route_dir = await create_route();
		await Bun.write(join(route_dir, "config.ts"), "export const columns = {};\n");
		await Bun.write(join(route_dir, "schema", "table.generated.ts"), "export const fields = {};\n");

		const result = await migrate_route_schema(route_dir);

		expect(result.moved).toEqual(["schema.generated.ts"]);
		expect(await Bun.file(join(route_dir, "config.ts")).text()).toBe("export const columns = {};\n");
		expect(await Bun.file(join(route_dir, "schema")).exists()).toBe(false);
	});

	test("rejects a conflict before moving any files", async () => {
		const route_dir = await create_route();
		await Bun.write(join(route_dir, "schema", "table.ts"), "legacy config\n");
		await Bun.write(join(route_dir, "config.ts"), "flat config\n");
		await Bun.write(join(route_dir, "schema", "table.generated.ts"), "generated\n");

		await expect(migrate_route_schema(route_dir)).rejects.toThrow("Schema migration conflict");
		expect(await Bun.file(join(route_dir, "schema", "table.generated.ts")).exists()).toBe(true);
		expect(await Bun.file(join(route_dir, "schema.generated.ts")).exists()).toBe(false);
	});
});
