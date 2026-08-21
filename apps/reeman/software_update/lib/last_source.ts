/** Remembers the last validated upstream source path between visits, purely as a form prefill convenience. */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const LAST_SOURCE_FILE = join(process.cwd(), ".reepolee", "reesync", "last-source.json");

export async function read_last_source(file: string = LAST_SOURCE_FILE): Promise<string> {
	try {
		const parsed = JSON.parse(await readFile(file, "utf8"));
		return typeof parsed?.path === "string" ? parsed.path : "";
	} catch {
		return "";
	}
}

export async function write_last_source(path: string, file: string = LAST_SOURCE_FILE): Promise<void> {
	try {
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, JSON.stringify({ path }), "utf8");
	} catch {
		// best-effort prefill only
	}
}
