#!/usr/bin/env bun
/**
 * Upload image - process a local disk file or remote URL through the same
 * pipeline the web image editor uses (lib/image_processor), then write the
 * resulting URL/key into a table column for a given row. Useful for seeding
 * or backfilling image fields (author portraits, recipe photos, etc.)
 * without going through the browser editor.
 */

import { uuid_v7 } from "$lib/uuid";
import { db_cli } from "$config/db_cli";
import { process_and_save_to_s3 } from "$lib/image_processor";
import { delete_temp_file, ensure_temp_dir } from "$lib/image_processor/helpers";
import { all_locale_tables } from "$lib/locale_tables";

import { ask, color, confirm, dim, GREEN, header, RED, select_from_list, show_cli_tip, YELLOW } from "./ui";

/**
 * Live column list straight from the database (PRAGMA/information_schema),
 * not the DDL cache - the cache deliberately excludes primary key columns
 * (they're not editable form fields), but upload-image needs the full,
 * real column set to validate an UPDATE ... WHERE id = ... against.
 */
async function get_live_table_columns(table: string): Promise<string[]> {
	const conn_str = Bun.env.CONNECTION_STRING?.trim() || "";
	const is_mysql = conn_str.toLowerCase().startsWith("mysql://");

	if (is_mysql) {
		const rows = (await db_cli.unsafe(
			"SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = $1",
			[table]
		)) as { column_name: string; }[];
		return rows.map((r) => r.column_name);
	}

	const rows = (await db_cli.unsafe(`PRAGMA table_info(${table})`)) as { name: string; }[];
	return rows.map((r) => r.name);
}

/**
 * Every physical table this write must touch, base first.
 *
 * An image column is a shared (non-localized) column, so its value has to be
 * identical in the base table and in every locale clone - a clone left holding
 * the old path renders a broken image on that locale's pages. all_locale_tables
 * names a clone for every configured locale whether or not the table is
 * localized, so each candidate is checked against the database and unlocalized
 * tables simply resolve to the base table alone.
 */
async function existing_locale_tables(table: string): Promise<string[]> {
	const candidates = all_locale_tables(table);
	const clones = candidates.slice(1);
	const present = [table];

	for (const clone of clones) {
		const columns = await get_live_table_columns(clone);
		if (columns.length > 0) present.push(clone);
	}

	return present;
}

export interface UploadImageOptions {
	table: string;
	id: string;
	column: string;
	source: string;
	folder?: string;
	format?: string;
	quality?: number;
}

function is_url(source: string): boolean { return /^https?:\/\//i.test(source); }

/**
 * Fetch a remote image into a temp file, returning the local path.
 * Caller is responsible for deleting the temp file once done.
 */
async function download_to_temp(url: string): Promise<string> {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);

	const temp_dir = await ensure_temp_dir();
	const ext = url.split(/[?#]/)[0]?.split(".").pop()?.slice(0, 5) || "bin";
	const temp_path = `${temp_dir}/${uuid_v7()}.${ext}`;

	await Bun.write(temp_path, response);
	return temp_path;
}

/**
 * Core operation: process the image from disk/URL and write the resulting
 * URL into <table>.<column> WHERE id = <id>. Returns the s3_url on success.
 */
export async function upload_image(options: UploadImageOptions): Promise<string | null> {
	const { table, id, column, source, folder = "", format = "webp", quality = 85 } = options;

	const columns = await get_live_table_columns(table);
	if (columns.length === 0) {
		console.log(`  ${color(`Table "${table}" not found (or has no columns).`, RED)}`);
		return null;
	}
	if (!columns.includes(column)) {
		console.log(`  ${color(`Column "${column}" not found on table "${table}".`, RED)}`);
		return null;
	}
	if (!columns.includes("id")) {
		console.log(`  ${color(`Table "${table}" has no "id" column - upload_image requires a numeric id primary key.`, RED)}`);
		return null;
	}

	const url_source = is_url(source);
	let input_path = source;
	let downloaded_temp_path: string | null = null;

	if (url_source) {
		console.log(`  ${dim(`Fetching ${source}...`)}`);
		try {
			input_path = await download_to_temp(source);
			downloaded_temp_path = input_path;
		} catch (err) {
			console.log(`  ${color(`Failed to download image: ${err}`, RED)}`);
			return null;
		}
	} else {
		const file = Bun.file(input_path);
		if (!(await file.exists())) {
			console.log(`  ${color(`File not found: ${input_path}`, RED)}`);
			return null;
		}
	}

	try {
		const result = await process_and_save_to_s3(input_path, { format, quality, folder });

		if (!result.s3_url) {
			console.log(`  ${color("Processing succeeded but no storage URL was produced (S3/local storage not configured?).", RED)}`);
			return null;
		}

		const target_tables = await existing_locale_tables(table);
		for (const target_table of target_tables) {
			await db_cli.unsafe(`UPDATE ${target_table} SET ${column} = $1 WHERE id = $2`, [result.s3_url, id]);
		}

		const original_filename = (url_source ? source : input_path).split(/[\\/]/).pop() || source;
		await db_cli.unsafe(
			`INSERT INTO images (folder, filename, s3_key, original_filename, mime_type, width, height, file_size) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
			[folder, result.filename, result.s3_key || result.filename, original_filename, result.mime, result.width, result.height, result.file_size]
		);

		console.log(`  ${color("✓", GREEN)} ${table}.${column} (id=${id}) -> ${result.s3_url}`);
		console.log(`  ${dim(`${result.width}x${result.height}, ${(result.file_size / 1024).toFixed(1)} KB`)}`);

		return result.s3_url;
	} finally {
		if (downloaded_temp_path) { await delete_temp_file(downloaded_temp_path); }
	}
}

// ---------------------------------------------------------------------------
// Interactive flow
// ---------------------------------------------------------------------------

export async function run_upload_image(): Promise<void> {
	header("Upload image from disk or URL");

	const table = await ask("Table name:");
	if (!table) {
		console.log(`  ${dim("(cancelled)")}`);
		return;
	}

	const columns = await get_live_table_columns(table);
	if (columns.length === 0) {
		console.log(`  ${color(`Table "${table}" not found (or has no columns).`, RED)}`);
		return;
	}

	const column = await select_from_list("Column to update", columns.map((c) => ({ value: c, label: c })));
	if (!column) {
		console.log(`  ${dim("(cancelled)")}`);
		return;
	}

	const id = await ask("Row id:");
	if (!id) {
		console.log(`  ${dim("(cancelled)")}`);
		return;
	}

	const source = await ask("Source (local file path or https:// URL):");
	if (!source) {
		console.log(`  ${dim("(cancelled)")}`);
		return;
	}

	const folder = await ask("Storage folder (optional, e.g. table name):", table);

	console.log();
	console.log(`  ${color("Table:", YELLOW)} ${table}`);
	console.log(`  ${color("Column:", YELLOW)} ${column}`);
	console.log(`  ${color("Row id:", YELLOW)} ${id}`);
	console.log(`  ${color("Source:", YELLOW)} ${source}`);
	console.log(`  ${color("Folder:", YELLOW)} ${folder || "(none)"}`);
	console.log();

	const proceed = await confirm("Upload and update this row?", "y");
	if (!proceed) {
		console.log(`  ${color("Cancelled.", YELLOW)}`);
		return;
	}

	const s3_url = await upload_image({ table, id, column, source, folder });
	if (!s3_url) return;

	const cli_cmd = `bun reeman upload-image ${table} ${id} ${column} "${source}"${folder ? ` --folder ${folder}` : ""}`;
	await show_cli_tip(cli_cmd, `Uploaded image to ${table}.${column} (id=${id})`);
}
