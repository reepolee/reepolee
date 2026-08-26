import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { update_table_file_settings } from "./write_table";

let temp_dir = "";

afterEach(async () => {
	if (temp_dir) await rm(temp_dir, { recursive: true, force: true });
	temp_dir = "";
});

describe("update_table_file_settings", () => {
	test("updates editable grid and strategy values without removing other properties", async () => {
		temp_dir = await mkdtemp(join(tmpdir(), "reepolee-table-settings-"));
		const table_path = join(temp_dir, "table.ts");
		const source = `const columns = {
\t"name": { width: "auto", class: "", domain: "string", localized: true },
\t"email": { width: "20ch", class: "text-right", filter: true, grid: false },
}
const pagination_strategy: "cursor" | "offset" = "offset";
const render_strategy: "stream" | "load" = "load";
const template_tags: "flat" | "tags" = "flat";
`;
		await Bun.write(table_path, source);

		await update_table_file_settings(table_path, {
			pagination_strategy: "cursor",
			render_strategy: "stream",
			template_tags: "tags",
			grid_columns: ["email"],
			grid_column_definitions: [
				{ name: "name", width: "18ch", class_name: "font-semibold", filter: true },
				{ name: "email", width: "auto", class_name: "", filter: false },
			],
		});

		const updated = await Bun.file(table_path).text();
		expect(updated).toContain('"name": { width: "18ch", class: "font-semibold", domain: "string", filter: true, grid: false, localized: true }');
		expect(updated).toContain('"email": { width: "auto", class: "" }');
		expect(updated).toContain('const pagination_strategy: "cursor" | "offset" = "cursor";');
		expect(updated).toContain('const render_strategy: "stream" | "load" = "stream";');
		expect(updated).toContain('const template_tags: "flat" | "tags" = "tags";');
	});

	test("writes and clears the per-column template helper", async () => {
		temp_dir = await mkdtemp(join(tmpdir(), "reepolee-table-helper-"));
		const table_path = join(temp_dir, "table.ts");
		const source = `const columns = {
\t"observed_at": { width: "auto", class: "" },
}
`;
		await Bun.write(table_path, source);

		await update_table_file_settings(table_path, {
			grid_column_definitions: [
				{ name: "observed_at", width: "auto", class_name: "", filter: false, helper: "js_datetime_to_locale_string" },
			],
		});

		let updated = await Bun.file(table_path).text();
		expect(updated).toContain('"observed_at": { width: "auto", class: "", helper: "js_datetime_to_locale_string"');

		// Clearing the helper (empty string) removes the property again.
		await update_table_file_settings(table_path, {
			grid_column_definitions: [
				{ name: "observed_at", width: "auto", class_name: "", filter: false, helper: "" },
			],
		});
		updated = await Bun.file(table_path).text();
		expect(updated).not.toContain("helper");
		expect(updated).toContain('"observed_at":');
	});
});
