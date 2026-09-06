/**
 * List .sql files available for the "Run SQL file" action.
 *
 * Mirrors generator/reeman/run_sql_file.ts's scanning: recurse through the
 * dialect-specific sql/<type>/ folder and all of its subfolders.
 */

import { statSync } from "node:fs";
import { dirname, join } from "node:path";

import { db_type } from "$lib/resolve_db_type";

export interface SqlFileEntry {
	/** Full path including the fixed "sql/<dialect>/" prefix, used as the form value. */
	path: string;
	/** Path relative to sql/<dialect>/, excluding the filename; "" when the file sits directly under it. */
	folder: string;
	/** Filename only, e.g. "01-init-sqlite.sql". */
	name: string;
	/** ISO timestamp of the file's last modification, e.g. "2026-08-17T11:25:13.000Z". */
	last_updated: string;
}

export async function list_sql_files(): Promise<SqlFileEntry[]> {
	const files: SqlFileEntry[] = [];

	const dialect_dir = join(process.cwd(), "sql", db_type);
	try {
		const glob = new Bun.Glob("**/*.sql");
		for await (const file of glob.scan({ cwd: dialect_dir, onlyFiles: true })) {
			const folder = dirname(file);
			const abs = join(dialect_dir, file);
			let last_updated = "";
			try {
				last_updated = statSync(abs).mtime.toISOString();
			} catch {
				// File vanished between scan and stat - leave the timestamp empty.
			}
			files.push({
				path: join("sql", db_type, file),
				folder: folder === "." ? "" : folder,
				name: file.slice(folder === "." ? 0 : folder.length + 1),
				last_updated,
			});
		}
	} catch {
		// sql/<dialect>/ does not exist
	}

	return files.sort((left, right) => left.path.localeCompare(right.path));
}
