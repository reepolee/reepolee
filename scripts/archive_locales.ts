/**
 * One-time migration: move all locale JSON files except en-us and sl-si into
 * locales-archive/ preserving each file's relative path from the repo root.
 *
 * Usage: bun scripts/archive_locales.ts [--dry-run]
 *
 * Safe for translation tooling: list_translation_files() only scans
 * routes/, apps/reeman/, apps/reeqa/, top-level {locale}.json files and
 * the locales/ directory - never locales-archive/.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, rename } from "node:fs/promises";
import { join, relative } from "node:path";

const KEEP = new Set(["en-us", "sl-si"]);
const ARCHIVE = "locales-archive";
const LOCALE_RE = /^([a-z]{2,3}-[a-z0-9]{2,8})\.json$/;
const dry_run = process.argv.includes("--dry-run");

async function walk(dir: string, out: string[]): Promise<void> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			await walk(full, out);
		} else if (entry.isFile()) {
			out.push(full);
		}
	}
}

async function main(): Promise<void> {
	const candidates: string[] = [];
	await walk(".", candidates);

	const to_move: string[] = [];
	for (const file of candidates) {
		if (file.startsWith("./node_modules") || file.startsWith("./.git") || file.startsWith("./.agents")) continue;
		if (file.split("/").includes(ARCHIVE)) continue;
		const base = file.split("/").pop()!;
		const match = LOCALE_RE.exec(base);
		if (!match) continue;
		const locale = match[1]!;
		if (KEEP.has(locale)) continue;
		to_move.push(file);
	}

	to_move.sort();
	console.log(`Archiving ${to_move.length} files into ${ARCHIVE}/ ...`);
	for (const file of to_move) {
		const rel = file.startsWith("./") ? file.slice(2) : file;
		const dest = join(ARCHIVE, rel);
		if (dry_run) {
			console.log(`  would move ${rel} -> ${dest}`);
			continue;
		}
		await mkdir(join(dest, ".."), { recursive: true });
		await rename(file, dest);
	}
	if (dry_run) console.log("(dry run - nothing moved)");
	console.log("Done.");
}

await main();
