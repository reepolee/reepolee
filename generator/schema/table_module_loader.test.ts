import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { load_table_module_fresh } from "./table_module_loader";

let temp_dir = "";

afterEach(async () => {
	if (temp_dir) await rm(temp_dir, { recursive: true, force: true });
	temp_dir = "";
});

describe("load_table_module_fresh", () => {
	test("reads table settings written after an earlier import", async () => {
		temp_dir = await mkdtemp(join(tmpdir(), "reepolee-table-module-"));
		const table_path = join(temp_dir, "table.ts");
		const initial_source = `export const columns = { name: { width: "auto", class: "" } };\n`;
		await Bun.write(table_path, initial_source);

		const initial_module = await load_table_module_fresh<{ columns: { name: { width: string; }; }; }>(table_path);
		expect(initial_module.columns.name.width).toBe("auto");

		const updated_source = `export const columns = { name: { width: "55ch", class: "" } };\n`;
		await Bun.write(table_path, updated_source);

		const updated_module = await load_table_module_fresh<{ columns: { name: { width: string; }; }; }>(table_path);
		expect(updated_module.columns.name.width).toBe("55ch");
	});
});
