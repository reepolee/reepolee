/**
 * Clone production DB -> test DB.
 *
 * Usage:
 * bun run db:clone-test               # interactive confirmation
 * bun run db:clone-test -- --yes      # skip confirmation
 * bun run db:clone-test -- --dry-run  # show what would happen
 * bun run db:clone-test -- --no-data  # DDL only (no row data)
 */

const args = process.argv.slice(2);
const is_dry_run = args.includes("--dry-run");
const skip_confirm = args.includes("--yes") || args.includes("-y");
const no_data = args.includes("--no-data");
const container_engine = Bun.env.CONTAINER_ENGINE ?? "podman";

const raw_source = (Bun.env.CONNECTION_STRING ?? "").replace(/^["']|["']$/g, "").trim();
const raw_target = (Bun.env.TEST_CONNECTION_STRING ?? "").replace(/^["']|["']$/g, "").trim();

if (!raw_source) {
	console.error("✗ CONNECTION_STRING is not set");
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

console.log(`Source: ${mask_password(raw_source)}`);
console.log(`Target: ${mask_password(raw_target)}`);
if (no_data) console.log("Mode: DDL only (no data)");
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

async function clone_mysql(raw_source: string, raw_target: string) {
	const src_db = extract_db_name(raw_source);
	const tgt_db = extract_db_name(raw_target);
	const { user, pass } = parse_mysql_auth(raw_source);

	console.log(`\nCreating target database \`${tgt_db}\`...`);
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

	// Get list of views so we can exclude them from the main dump
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
		`SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${src_db}' AND TABLE_TYPE = 'VIEW'`,
	]);
	const views_raw = new TextDecoder().decode(views_res.stdout).trim();
	const view_names = views_raw ? views_raw.split("\n").map((s) => s.trim()).filter(Boolean) : [];

	// Exclude views from main dump (dump tables + data only)
	const ignore_args = view_names.flatMap((v) => ["--ignore-table", `${src_db}.${v}`]);

	console.log("Dumping source → target...");
	const start = performance.now();

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
	];
	if (no_data) { dump_args.push("--no-data"); }
	dump_args.push(...ignore_args, src_db);

	const dump_proc = Bun.spawn({ cmd: dump_args, stdout: "pipe", stderr: "pipe" });

	const load_proc = Bun.spawn({
		cmd: [container_engine, "exec", "-i", "mariadb", "mariadb", "-u", user, `-p${pass}`, tgt_db],
		stdin: dump_proc.stdout,
		stdout: "pipe",
		stderr: "pipe",
	});

	const [dump_exit, load_exit] = await Promise.all([dump_proc.exited, load_proc.exited]);
	const elapsed = ((performance.now() - start) / 1000).toFixed(1);

	if (dump_exit !== 0 || load_exit !== 0) {
		let err_msg = "";
		const dump_err = await read_stream(dump_proc.stderr);
		const load_err = await read_stream(load_proc.stderr);
		if (dump_exit !== 0) err_msg += dump_err;
		if (load_exit !== 0) err_msg += load_err;
		console.error(`\nClone failed after ${elapsed}s:\n${err_msg}`);
		process.exit(1);
	}

	console.log(`\nClone complete in ${elapsed}s.`);

	// Copy views separately (one at a time, skip broken ones)
	console.log(`\nCopying ${view_names.length} views...`);
	for (const view of view_names) {
		const create_res = Bun.spawnSync([
			container_engine,
			"exec",
			"mariadb",
			"mariadb",
			"-u",
			user,
			`-p${pass}`,
			src_db,
			"-N",
			"-e",
			`SHOW CREATE VIEW \`${view}\``,
		]);
		if (create_res.exitCode === 0) {
			const output = new TextDecoder().decode(create_res.stdout);
			const ddl_match = output.match(/CREATE .*/);
			if (ddl_match) {
				const ddl = ddl_match[0];
				const load_view_res = Bun.spawnSync([
					container_engine,
					"exec",
					"mariadb",
					"mariadb",
					"-u",
					user,
					`-p${pass}`,
					tgt_db,
					"-e",
					`DROP VIEW IF EXISTS \`${view}\`; ${ddl}`,
				]);
				if (load_view_res.exitCode === 0) {
					console.log(`  view   ${view}`);
				} else {
					console.log(`  skip   ${view} (broken - load failed)`);
				}
			} else {
				console.log(`  skip   ${view} (no CREATE in output)`);
			}
		} else {
			console.log(`  skip   ${view} (broken)`);
		}
	}

	process.exit(0);
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
		console.log(`\nTables to clone: ${tables.length}`);

		const skip_table_set = new Set(SKIP_DATA_TABLES);

		for (const table_name of tables) {
			const skip_data = skip_table_set.has(table_name);

			const create_result = await source_db.unsafe("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [table_name]);
			const create_sql = create_result[0].sql as string;

			await target_db.unsafe(`DROP TABLE IF EXISTS "${table_name}"`);
			await target_db.unsafe(create_sql);

			if (!skip_data) {
				const rows = await source_db.unsafe(`SELECT * FROM "${table_name}"`);
				if (rows.length > 0) {
					const columns = Object.keys(rows[0]);
					const placeholders = columns.map(() => "?").join(", ");
					const col_names = columns.map((c) => `"${c}"`).join(", ");
					const insert_sql = `INSERT INTO "${table_name}" (${col_names}) VALUES (${placeholders})`;

					for (const row of rows) {
						await target_db.unsafe(insert_sql, columns.map((c) => row[c]));
					}
				}
			}

			const count = await target_db.unsafe(`SELECT COUNT(*) AS cnt FROM "${table_name}"`);
			console.log(`  ${skip_data ? "schema" : "copied"}  ${table_name.padEnd(30)} ${count[0].cnt} rows`);
		}

		const views = await source_db.unsafe("SELECT name, sql FROM sqlite_master WHERE type = 'view'");
		for (const view of views) {
			await target_db.unsafe(`DROP VIEW IF EXISTS "${view.name}"`);
			await target_db.unsafe(view.sql);
			console.log(`  view   ${view.name}`);
		}

		console.log("\nClone complete.");
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
		if (match) return match[1];
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
	if (match) { return `${match[1] + match[2] + match[3]}***${match[5]}`; }
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
