import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_ENV_FILE_BYTES, read_env_file, write_env_file } from "./env_file";

const temp_dirs: string[] = [];

async function make_temp_dir(): Promise<string> {
	const temp_dir = await mkdtemp(join(tmpdir(), "reepolee-env-manager-"));
	temp_dirs.push(temp_dir);
	return temp_dir;
}

afterEach(async () => {
	for (const temp_dir of temp_dirs.splice(0)) {
		await rm(temp_dir, { recursive: true, force: true });
	}
});

describe("environment file manager", () => {
	test("reports a missing .env without creating it", async () => {
		const temp_dir = await make_temp_dir();
		const env_file = await read_env_file(temp_dir);

		expect(env_file.exists).toBe(false);
		expect(env_file.content).toBe("");
		expect(env_file.path).toBe(join(temp_dir, ".env"));
	});

	test("writes and reads .env content without changing it", async () => {
		const temp_dir = await make_temp_dir();
		const content = "APP_NAME=Reepolee\nSECRET=one=two\n";

		await write_env_file(content, temp_dir);
		const env_file = await read_env_file(temp_dir);

		expect(env_file.exists).toBe(true);
		expect(env_file.content).toBe(content);
	});

	test("rejects files larger than the editor limit", async () => {
		const temp_dir = await make_temp_dir();
		const content = "x".repeat(MAX_ENV_FILE_BYTES + 1);

		expect(write_env_file(content, temp_dir)).rejects.toThrow("1 MB or smaller");
	});
});
