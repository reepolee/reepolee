import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { write_validation_file } from "./write_validation";
import type { SchemaObject } from "./types";
import type { TypeMapper } from "./type_mapper";

test("write_validation_file preserves existing user validation", async () => {
	const temp_dir = await mkdtemp(join(tmpdir(), "reepolee-validation-writer-"));
	try {
		const validation_path = join(temp_dir, "validation_server.ts");
		const custom_validation = "export const validate = () => ({ custom: true });\n";
		await Bun.write(validation_path, custom_validation);

		await write_validation_file(temp_dir, {} as SchemaObject, {} as TypeMapper);

		expect(await Bun.file(validation_path).text()).toBe(custom_validation);
	} finally {
		await rm(temp_dir, { recursive: true, force: true });
	}
});
