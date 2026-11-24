import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { write_validation_file } from "./write_validation";
import type { SchemaObject } from "./types";
import type { TypeMapper } from "./type_mapper";

const text_mapper: TypeMapper = {
	to_html_input: () => "text",
	to_typescript: () => "string",
};

const reports_schema: SchemaObject = {
	type: "table",
	name: "reports",
	columns: [
		{ name: "id", type_string: "int", comment: "", is_nullable: false, is_primary_key: true, is_auto_increment: true },
		{ name: "title", type_string: "varchar(255)", comment: "", is_nullable: false, is_primary_key: false, is_auto_increment: false },
	],
	foreign_keys: [],
	has_view: false,
};

test("write_validation_file replaces stale validation from the current schema", async () => {
	const temp_dir = await mkdtemp(join(tmpdir(), "reepolee-validation-writer-"));
	try {
		const validation_path = join(temp_dir, "validation_server.ts");
		const custom_validation = "export const validate = () => ({ custom: true });\n";
		await Bun.write(validation_path, custom_validation);

		await write_validation_file(temp_dir, reports_schema, text_mapper, undefined, undefined, { id: { form: true }, title: { form: true } });

		const validation = await Bun.file(validation_path).text();
		expect(validation).toContain("title: z.string().min(1, \"title_required\").max(255, \"title_max\")");
		expect(validation).not.toContain(custom_validation);
	} finally {
		await rm(temp_dir, { recursive: true, force: true });
	}
});

test("write_validation_file refreshes generated field definitions", async () => {
	const temp_dir = await mkdtemp(join(tmpdir(), "reepolee-validation-writer-"));
	try {
		const validation_path = join(temp_dir, "validation_server.ts");
		await write_validation_file(temp_dir, reports_schema, text_mapper, undefined, undefined, { title: { form: true } });
		await Bun.write(validation_path, "export const schema = null;\n");
		await write_validation_file(temp_dir, reports_schema, text_mapper, undefined, undefined, { title: { form: true } });

		const refreshed = await Bun.file(validation_path).text();
		expect(refreshed).toContain("title: z.string().min(1, \"title_required\").max(255, \"title_max\")");
		expect(refreshed).not.toContain("export const schema = null");
	} finally {
		await rm(temp_dir, { recursive: true, force: true });
	}
});
