/**
 * Clone production DB -> test DB.
 *
 * Usage:
 * bun run db:clone-test               # interactive confirmation
 * bun run db:clone-test -- --yes      # skip confirmation
 * bun run db:clone-test -- --dry-run  # show what would happen
 * bun run db:clone-test -- --no-data  # DDL only (no row data)
 * bun run db:clone-test -- --quiet    # summary only (used by the installer)
 * bun run db:clone-test -- --snapshot <file>  # dump test DB to a file
 * bun run db:clone-test -- --restore <file>   # load a snapshot into the test DB
 */

const args = process.argv.slice(2);
const is_dry_run = args.includes("--dry-run");
const skip_confirm = args.includes("--yes") || args.includes("-y");
const no_data = args.includes("--no-data");
// The installer reports its own progress line, so suppress the per-table log.
const is_quiet = args.includes("--quiet");
const container_engine = Bun.env.CONTAINER_ENGINE ?? "podman";

// Snapshot/restore modes (used by ReeQA's baseline/test flow). They touch the
// test DB only - dev is never read again after the initial clone.
const snapshot_index = args.indexOf("--snapshot");
const restore_index = args.indexOf("--restore");
const snapshot_path = snapshot_index !== -1 ? args[snapshot_index + 1] : undefined;
const restore_path = restore_index !== -1 ? args[restore_index + 1] : undefined;

const raw_source = (Bun.env.DEV_CONNECTION_STRING ?? "").replace(/^["']|["']$/g, "").trim();
const raw_target = (Bun.env.TEST_CONNECTION_STRING ?? "").replace(/^["']|["']$/g, "").trim();

if (snapshot_index !== -1 || restore_index !== -1) {
	if (snapshot_index !== -1 && !snapshot_path) {
		console.error("✗ --snapshot requires a file path");
		process.exit(1);
	}
	if (restore_index !== -1 && !restore_path) {
		console.error("✗ --restore requires a file path");
		process.exit(1);
	}
	if (!raw_target) {
		console.error("✗ TEST_CONNECTION_STRING is not set");
		process.exit(1);
	}
	const target_prefix = raw_target.split(":")[0]?.toLowerCase();
	const target_db_name = extract_db_name(raw_target);
	if (!target_db_name.toLowerCase().includes("test")) {
		console.error(
			`✗ Target database "${target_db_name}" does not contain "test" in its name.\n  Refusing to snapshot/restore a non-test database.\n  Set TEST_CONNECTION_STRING to a database with "test" in the name.`
		);
		process.exit(1);
	}
	if (snapshot_path) {
		if (target_prefix === "mysql") await snapshot_mysql(raw_target, snapshot_path);
		else await snapshot_sqlite(raw_target, snapshot_path);
	} else {
		if (target_prefix === "mysql") await restore_mysql(raw_target, restore_path!);
		else await restore_sqlite(raw_target, restore_path!);
	}
	process.exit(0);
}

if (!raw_source) {
	console.error("✗ DEV_CONNECTION_STRING is not set");
	process.exit(1);
}
if (!raw_target) {
	console.error("✗ TEST_CONNECTION_STRING is not set");
	process.exit(1);
}

const source_prefix = raw_source.split(":")[0]?.toLowerCase();
const target_prefix = raw_target.split(":")[0]?.toLowerCase();

if (source_prefix !== target_prefix) {
	console.error(`✗ Source (${source_prefix}) and target (${target_prefix}) DB types must match`);
	process.exit(1);
}

const target_db_name = extract_db_name(raw_target);
if (!target_db_name.toLowerCase().includes("test")) {
	console.error(
		`✗ Target database "${target_db_name}" does not contain "test" in its name.\n  Refusing to clone to a non-test database.\n  Set TEST_CONNECTION_STRING to a database with "test" in the name.`
	);
	process.exit(1);
}

const SKIP_DATA_TABLES: string[] = [];

if (!is_quiet) {
	console.log(`Source: ${mask_password(raw_source)}`);
	console.log(`Target: ${mask_password(raw_target)}`);
}
if (no_data && !is_quiet) console.log("Mode: DDL only (no data)");
if (is_dry_run) {
	console.log("Mode: dry-run (no changes)\n");
	process.exit(0);
}

if (!skip_confirm) {
	const answer = prompt("Proceed with clone? [y/N]");
	if (!answer || (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes")) {
		console.log("Aborted.");
		process.exit(0);
	}
}

if (source_prefix === "mysql") {
	await clone_mysql(raw_source, raw_target);
} else {
	await clone_sqlite(raw_source, raw_target);
}

async function snapshot_mysql(raw_target: string, file_path: string) {
	const tgt_db = extract_db_name(raw_target);
	const { user, pass } = parse_mysql_auth(raw_target);

	// Exclude views from the main dump and append their definitions afterwards,
	// matching clone_mysql's robustness against broken views.
	const views_res = Bun.spawnSync([
		container_engine,
		"exec",
		"mariadb",
		"mariadb",
		"-u",
		user,
		`-p${pass}`,
		"-N",
		"-e",
		`SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${tgt_db}' AND TABLE_TYPE = 'VIEW'`,
	]);
	const views_raw = new TextDecoder().decode(views_res.stdout).trim();
	const view_names = views_raw ? views_raw.split("\n").map((s) => s.trim()).filter(Boolean) : [];
	const ignore_args = view_names.flatMap((v) => ["--ignore-table", `${tgt_db}.${v}`]);

	const dump_args = [
		container_engine,
		"exec",
		"mariadb",
		"mariadb-dump",
		"-u",
		user,
		`-p${pass}`,
		"--no-create-db",
		"--single-transaction",
		"--quick",
		...ignore_args,
		tgt_db,
	];
	const dump_proc = Bun.spawn({ cmd: dump_args, stdout: "pipe", stderr: "pipe" });

	const writer = Bun.file(file_path).writer();
	for await (const chunk of dump_proc.stdout) writer.write(chunk);
	const dump_exit = await dump_proc.exited;
	if (dump_exit !== 0) {
		const err = await read_stream(dump_proc.stderr);
		console.error(`Snapshot dump failed:\n${err}`);
		process.exit(1);
	}

	let view_sql = "";
	for (const view of view_names) {
		const create_res = Bun.spawnSync([
			container_engine,
			"exec",
			"mariadb",
			"mariadb",
			"-u",
			user,
			`-p${pass}`,
			tgt_db,
			"-N",
			"-e",
			`SHOW CREATE VIEW \`${view}\``,
		]);
		if (create_res.exitCode === 0) {
			const output = new TextDecoder().decode(create_res.stdout);
			const ddl_match = output.match(/CREATE .*/);
			if (ddl_match) view_sql += `DROP VIEW IF EXISTS \`${view}\`;\n${ddl_match[0]};\n`;
		}
	}
	if (view_sql) writer.write(`\n-- Views\n${view_sql}`);
	await writer.end();
	console.log(`Snapshot saved to ${file_path}`);
}

async function restore_mysql(raw_target: string, file_path: string) {
	const tgt_db = extract_db_name(raw_target);
	const { user, pass } = parse_mysql_auth(raw_target);

	const snapshot_file = Bun.file(file_path);
	if (!(await snapshot_file.exists())) {
		console.error(`✗ Snapshot file not found: ${file_path}`);
		process.exit(1);
	}

	const create_res = Bun.spawnSync([
		container_engine,
		"exec",
		"mariadb",
		"mariadb",
		"-u",
		user,
		`-p${pass}`,
		"-e",
		`DROP DATABASE IF EXISTS \`${tgt_db}\`; CREATE DATABASE \`${tgt_db}\``,
	]);
	if (create_res.exitCode !== 0) {
		console.error(new TextDecoder().decode(create_res.stderr));
		process.exit(1);
	}

	const load_proc = Bun.spawn({
		cmd: [container_engine, "exec", "-i", "mariadb", "mariadb", "-u", user, `-p${pass}`, tgt_db],
		stdin: snapshot_file.stream(),
		stdout: "pipe",
		stderr: "pipe",
	});
	const load_exit = await load_proc.exited;
	if (load_exit !== 0) {
		const err = await read_stream(load_proc.stderr);
		console.error(`Restore failed:\n${err}`);
		process.exit(1);
	}
	console.log("Restore complete.");
}

async function snapshot_sqlite(raw_target: string, file_path: string) {
	const db_path = extract_db_name(raw_target);
	const source = Bun.file(db_path);
	if (!(await source.exists())) {
		console.error(`✗ SQLite database not found: ${db_path}`);
		process.exit(1);
	}
	await Bun.write(file_path, source);
	console.log(`Snapshot saved to ${file_path}`);
}

async function restore_sqlite(raw_target: string, file_path: string) {
	const db_path = extract_db_name(raw_target);
	const source = Bun.file(file_path);
	if (!(await source.exists())) {
		console.error(`✗ Snapshot file not found: ${file_path}`);
		process.exit(1);
	}
	await Bun.write(db_path, source);
	console.log("Restore complete.");
}

async function clone_mysql(raw_source: string, raw_target: string) {
	const { SQL } = await import("bun");
	const src_db = extract_db_name(raw_source);
	const tgt_db = extract_db_name(raw_target);
	const source_db = new SQL(raw_source);
	const target_admin_db = new SQL(mysql_admin_url(raw_target));
	let target_db: InstanceType<typeof SQL> | null = null;
	const keepalive = setInterval(() => {}, 2_147_483_647);
	const start = performance.now();

	try {
		await source_db.connect();
		await target_admin_db.connect();

		console.log(`\nCreating target database \`${tgt_db}\` on the configured MySQL server...`);
		await target_admin_db.unsafe(`DROP DATABASE IF EXISTS ${quote_mysql_identifier(tgt_db)}`);
		await target_admin_db.unsafe(`CREATE DATABASE ${quote_mysql_identifier(tgt_db)}`);

		target_db = new SQL(raw_target);
		await target_db.connect();
		await target_db.unsafe("SET FOREIGN_KEY_CHECKS = 0");

		const table_rows = await source_db.unsafe(
			`SELECT TABLE_NAME AS table_name
			 FROM information_schema.TABLES
			 WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
			 ORDER BY TABLE_NAME`,
			[src_db],
		) as unknown as Array<Record<string, unknown>>;
		const table_names = table_rows.map((row) => String(row.table_name ?? row.TABLE_NAME));

		if (!is_quiet) console.log(`Copying ${table_names.length} tables...`);
		let total_rows = 0;
		for (const table_name of table_names) {
			const source_table = qualify_mysql_name(src_db, table_name);
			const target_table = qualify_mysql_name(tgt_db, table_name);
			const create_sql = await get_mysql_create_statement(source_db, "TABLE", source_table);
			await target_db.unsafe(create_sql);

			const skip_data = no_data || SKIP_DATA_TABLES.includes(table_name);
			if (!skip_data) {
				const columns = await get_mysql_copy_columns(source_db, src_db, table_name);
				if (columns.length > 0) {
					if (mysql_same_server(raw_source, raw_target)) {
						await target_db.unsafe(
							`INSERT INTO ${target_table} (${quote_mysql_columns(columns)}) SELECT ${quote_mysql_columns(columns)} FROM ${source_table}`,
						);
					} else {
						await copy_mysql_rows(source_db, target_db, source_table, target_table, columns);
					}
				}
			}

			const count_rows = await target_db.unsafe(`SELECT COUNT(*) AS row_count FROM ${target_table}`) as unknown as Array<Record<string, unknown>>;
			const row_count = Number(count_rows[0]?.row_count ?? count_rows[0]?.ROW_COUNT ?? 0);
			total_rows += row_count;
			if (!is_quiet) console.log(`  ${skip_data ? "schema" : "copied"}  ${table_name.padEnd(30)} ${row_count} rows`);
		}

		const view_rows = await source_db.unsafe(
			`SELECT TABLE_NAME AS table_name
			 FROM information_schema.TABLES
			 WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'VIEW'
			 ORDER BY TABLE_NAME`,
			[src_db],
		) as unknown as Array<Record<string, unknown>>;
		const view_names = view_rows.map((row) => String(row.table_name ?? row.TABLE_NAME));

		if (!is_quiet) console.log(`\nCopying ${view_names.length} views...`);
		for (const view_name of view_names) {
			try {
				const source_view = qualify_mysql_name(src_db, view_name);
				const target_view = qualify_mysql_name(tgt_db, view_name);
				const create_sql = await get_mysql_create_statement(source_db, "VIEW", source_view);
				const target_sql = rewrite_mysql_schema(create_sql, src_db, tgt_db);
				await target_db.unsafe(`DROP VIEW IF EXISTS ${target_view}`);
				await target_db.unsafe(target_sql);
				if (!is_quiet) console.log(`  view   ${view_name}`);
			} catch {
				if (!is_quiet) console.log(`  skip   ${view_name} (broken)`);
			}
		}

		const trigger_rows = await source_db.unsafe(
			`SELECT TRIGGER_NAME AS trigger_name
			 FROM information_schema.TRIGGERS
			 WHERE TRIGGER_SCHEMA = ?
			 ORDER BY ACTION_ORDER, TRIGGER_NAME`,
			[src_db],
		) as unknown as Array<Record<string, unknown>>;
		const trigger_names = trigger_rows.map((row) => String(row.trigger_name ?? row.TRIGGER_NAME));

		for (const trigger_name of trigger_names) {
			try {
				const source_trigger = qualify_mysql_name(src_db, trigger_name);
				const create_sql = await get_mysql_create_statement(source_db, "TRIGGER", source_trigger);
				await target_db.unsafe(rewrite_mysql_schema(create_sql, src_db, tgt_db));
			} catch {
				if (!is_quiet) console.log(`  skip   trigger ${trigger_name} (broken)`);
			}
		}

		await target_db.unsafe("SET FOREIGN_KEY_CHECKS = 1");
		const elapsed = ((performance.now() - start) / 1000).toFixed(1);
		if (is_quiet) console.log(`${table_names.length} tables, ${total_rows} rows`);
		else console.log(`\nClone complete in ${elapsed}s.`);
	} catch (error) {
		const elapsed = ((performance.now() - start) / 1000).toFixed(1);
		const message = error instanceof Error ? error.message : String(error);
		console.error(`\nClone failed after ${elapsed}s:\n${message}`);
		process.exitCode = 1;
	} finally {
		clearInterval(keepalive);
		if (target_db) await target_db.close();
		await target_admin_db.close();
		await source_db.close();
	}
}

function mysql_admin_url(raw: string): URL {
	const url = new URL(raw.replace(/^['"]|['"]$/g, "").trim());
	url.pathname = "/";
	return url;
}

function mysql_same_server(raw_source: string, raw_target: string): boolean {
	const source_url = new URL(raw_source);
	const target_url = new URL(raw_target);
	const source_port = source_url.port || "3306";
	const target_port = target_url.port || "3306";
	return source_url.hostname.toLowerCase() === target_url.hostname.toLowerCase() && source_port === target_port;
}

function quote_mysql_identifier(identifier: string): string {
	return `\`${identifier.replaceAll("`", "``")}\``;
}

function qualify_mysql_name(database: string, name: string): string {
	return `${quote_mysql_identifier(database)}.${quote_mysql_identifier(name)}`;
}

function quote_mysql_columns(columns: string[]): string {
	return columns.map((column) => quote_mysql_identifier(column)).join(", ");
}

async function get_mysql_create_statement(db: InstanceType<typeof import("bun").SQL>, object_type: string, qualified_name: string): Promise<string> {
	const rows = await db.unsafe(`SHOW CREATE ${object_type} ${qualified_name}`) as unknown as Array<Record<string, unknown>>;
	const row = rows[0];
	if (!row) throw new Error(`No ${object_type} definition returned for ${qualified_name}`);
	for (const value of Object.values(row)) {
		if (typeof value === "string" && /^\s*CREATE\b/i.test(value)) return value.trim();
	}
	throw new Error(`No CREATE statement returned for ${qualified_name}`);
}

async function get_mysql_copy_columns(db: InstanceType<typeof import("bun").SQL>, database: string, table: string): Promise<string[]> {
	const rows = await db.unsafe(
		`SELECT COLUMN_NAME AS column_name
		 FROM information_schema.COLUMNS
		 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COALESCE(GENERATION_EXPRESSION, '') = ''
		 ORDER BY ORDINAL_POSITION`,
		[database, table],
	) as unknown as Array<Record<string, unknown>>;
	return rows.map((row) => String(row.column_name ?? row.COLUMN_NAME));
}

async function copy_mysql_rows(
	source_db: InstanceType<typeof import("bun").SQL>,
	target_db: InstanceType<typeof import("bun").SQL>,
	source_table: string,
	target_table: string,
	columns: string[],
): Promise<void> {
	const rows = await source_db.unsafe(`SELECT ${quote_mysql_columns(columns)} FROM ${source_table}`) as unknown as Array<Record<string, unknown>>;
	const row_placeholders = `(${columns.map(() => "?").join(", ")})`;
	const insert_columns = quote_mysql_columns(columns);
	const batch_size = 100;

	for (let offset = 0; offset < rows.length; offset += batch_size) {
		const batch = rows.slice(offset, offset + batch_size);
		const values: unknown[] = [];
		for (const row of batch) {
			for (const column of columns) values.push(row[column]);
		}
		const placeholders = batch.map(() => row_placeholders).join(", ");
		await target_db.unsafe(`INSERT INTO ${target_table} (${insert_columns}) VALUES ${placeholders}`, values);
	}
}

function rewrite_mysql_schema(sql: string, source_database: string, target_database: string): string {
	return sql.replaceAll(`${quote_mysql_identifier(source_database)}.`, `${quote_mysql_identifier(target_database)}.`);
}

function parse_mysql_auth(raw: string): { user: string; pass: string; } {
	try {
		const clean = raw.replace(/^["']|["']$/g, "").trim();
		const url_obj = new URL(clean);
		return {
			user: decodeURIComponent(url_obj.username || "root"),
			pass: decodeURIComponent(url_obj.password || ""),
		};
	} catch {
		return { user: "root", pass: "" };
	}
}

async function clone_sqlite(raw_source: string, raw_target: string) {
	const { SQL } = await import("bun");
	const source_db = new SQL(raw_source);
	const target_db = new SQL(raw_target);

	const stay_alive = setInterval(() => {}, 2_147_483_647);

	try {
		const tables_result = await source_db.unsafe("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
		const tables: string[] = tables_result.map((r: any) => r.name);
		if (!is_quiet) { console.log(`\nTables to clone: ${tables.length}`); }

		const skip_table_set = new Set(SKIP_DATA_TABLES);
		let total_rows = 0;

		for (const table_name of tables) {
			const skip_data = skip_table_set.has(table_name);
			const copy_data = !no_data && !skip_data;

			const create_result = await source_db.unsafe("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [table_name]);
			const create_sql = create_result[0].sql as string;

			await target_db.unsafe(`DROP TABLE IF EXISTS "${table_name}"`);
			await target_db.unsafe(create_sql);

			if (copy_data) {
				const rows = await source_db.unsafe(`SELECT * FROM "${table_name}"`);
				if (rows.length > 0) {
					const table_info = await source_db.unsafe(`PRAGMA table_xinfo("${table_name}")`);
					const writable_column_rows = table_info.filter((column: any) => column.hidden === 0);
					const writable_columns = writable_column_rows.map((column: any) => column.name);
					const row_columns = Object.keys(rows[0]);
					const columns = row_columns.filter((column) => writable_columns.includes(column));
					const placeholders = columns.map(() => "?").join(", ");
					const col_names = columns.map((c) => `"${c}"`).join(", ");
					const insert_sql = `INSERT INTO "${table_name}" (${col_names}) VALUES (${placeholders})`;

					for (const row of rows) {
						await target_db.unsafe(insert_sql, columns.map((c) => row[c]));
					}
				}
			}

			const count = await target_db.unsafe(`SELECT COUNT(*) AS cnt FROM "${table_name}"`);
			const row_count = Number(count[0].cnt);
			total_rows += row_count;
			if (!is_quiet) { console.log(`  ${copy_data ? "copied" : "schema"}  ${table_name.padEnd(30)} ${row_count} rows`); }
		}

		const views = await source_db.unsafe("SELECT name, sql FROM sqlite_master WHERE type = 'view'");
		for (const view of views) {
			await target_db.unsafe(`DROP VIEW IF EXISTS "${view.name}"`);
			await target_db.unsafe(view.sql);
			if (!is_quiet) { console.log(`  view   ${view.name}`); }
		}

		if (is_quiet) {
			// One machine-readable line the installer turns into its detail text.
			console.log(`${tables.length} tables, ${total_rows} rows`);
		} else {
			console.log("\nClone complete.");
		}
	} finally {
		clearInterval(stay_alive);
		await source_db.close();
		await target_db.close();
	}
}

function extract_db_name(url: string): string {
	const clean = url.replace(/^["']|["']$/g, "").trim();
	if (clean.startsWith("mysql://")) {
		const match = clean.match(/^mysql:\/\/.*@[^/]+\/([^?]+)/);
		if (match) return match[1]!;
		return clean.split("/").pop() ?? clean;
	}
	if (clean.startsWith("sqlite:")) {
		return clean.slice("sqlite:".length).replace(
			/^\/\//,
			""
		);
	}
	try {
		return new URL(clean).pathname.replace(
			/^\//,
			""
		);
	} catch {
		return clean;
	}
}

function mask_password(raw: string): string {
	const match = raw.match(/^(mysql:\/\/)([^:]*)(:)([^@]*)(@.*)/);
	if (match) { return `${match[1]! + match[2]! + match[3]!}***${match[5]}`; }
	return raw;
}

async function read_stream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
	if (!stream) return "";
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
	}
	const total = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
	let offset = 0;
	for (const chunk of chunks) {
		total.set(chunk, offset);
		offset += chunk.length;
	}
	return new TextDecoder().decode(total);
}
