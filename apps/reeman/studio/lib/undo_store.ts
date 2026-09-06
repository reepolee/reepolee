/**
 * Studio - per-table version cache, stored outside the SQL file entirely.
 *
 * Each edit that changes the DDL is a new version: version 0 is always the
 * on-disk table (recorded the first time a table is opened), version N is
 * the table state after the Nth real edit. The page URL carries `?v=N`, so
 * a reload always renders that exact version - no client-side stack, no
 * pop, no checkpoint dedup. Undo simply navigates to `?v=N-1`.
 *
 * One JSON file per (path, table) under .reepolee/studio-undo/, holding an
 * array of StudioTable snapshots indexed by version. Kept off disk in the
 * SQL file itself so editing never writes to the tracked .sql file until
 * the operator saves.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { StudioTable } from "./types";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const STORE_DIR = join(REPO_ROOT, ".reepolee", "studio-undo");
const MAX_VERSIONS = 50;

function store_path(model_path: string, table_name: string): string {
	const safe = `${model_path}::${table_name}`.replace(/[^a-zA-Z0-9._-]/g, "_");
	return join(STORE_DIR, `${safe}.json`);
}

function read_versions(model_path: string, table_name: string): StudioTable[] {
	try {
		const raw = readFileSync(store_path(model_path, table_name), "utf-8");
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed as StudioTable[] : [];
	} catch {
		return [];
	}
}

function write_versions(model_path: string, table_name: string, versions: StudioTable[]): void {
	mkdirSync(STORE_DIR, { recursive: true });
	writeFileSync(store_path(model_path, table_name), JSON.stringify(versions), "utf-8");
}

/** Version 0 is the on-disk table - (re)start a fresh edit session from it, discarding any prior history. */
export function reset_versions(model_path: string, table_name: string, source: StudioTable): void {
	write_versions(model_path, table_name, [source]);
}

/**
 * Append a new version (the result of a real edit) and return its index.
 * Truncates any versions past `after_version` first, so editing after an
 * undo discards the redone-away branch instead of leaving it dangling.
 */
export function push_version(model_path: string, table_name: string, after_version: number, table: StudioTable): number {
	const versions = read_versions(model_path, table_name).slice(0, after_version + 1);
	versions.push(table);
	while (versions.length > MAX_VERSIONS) versions.shift();
	write_versions(model_path, table_name, versions);
	return versions.length - 1;
}

/** Look up a specific version's table state, or null if it doesn't exist. */
export function get_version(model_path: string, table_name: string, version: number): StudioTable | null {
	const versions = read_versions(model_path, table_name);
	return versions[version] ?? null;
}

/** Drop all history for a table - called after a real save, since version 0 (disk) just moved. */
export function clear_versions(model_path: string, table_name: string): void {
	try {
		rmSync(store_path(model_path, table_name), { force: true });
	} catch {
		/* nothing to clear */
	}
}
