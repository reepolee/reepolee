import { mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { join, relative } from "node:path";

import { db_cli } from "$config/db_cli";
import { IGNORE_TABLES, INTERNAL_TABLE_PREFIX } from "$config/db_structure";
import { normalize_prefix } from "$lib/route";
import { db_type } from "$lib/resolve_db_type";
import { notify_server_reload } from "$lib/server_notify";

import { singularize } from "./naming";
import { build_table_column_map, capitalize_label, get_and_clear_missing_index_warnings } from "./schema/field_generator";
import {
	write_table_file,
	write_table_generated_file,
	write_translation_files,
	write_validation_file,
} from "./schema/file_writer";
import { MySQLTypeMapper } from "./schema/mysql/mysql_type_mapper";
import { SQLiteTypeMapper } from "./schema/sqlite/sqlite_type_mapper";

// ---------------------------------------------------------------------------
// Exported API - callable from other modules
// ---------------------------------------------------------------------------

export interface SchemaOptions {
	prefix?: string;
	parent_table?: string;
	pagination_strategy?: "cursor" | "offset";
	route_name?: string;
}

export async function generate_schema(target: string, options: SchemaOptions = {}): Promise<boolean> {
	const { clean: clean_prefix } = normalize_prefix(options.prefix ?? "");
	const parent_table = options.parent_table ?? "";
	const route_name = options.route_name ?? "";

	if (parent_table && target === "all") {
		console.error("✗ --parent flag cannot be used with 'all' target. Generate the child table individually.");
		return false;
	}

	const type_mapper_map = new Map([["mysql", () => new MySQLTypeMapper()], ["sqlite", () => new SQLiteTypeMapper()]]);

	const type_mapper = type_mapper_map.get(db_type)?.();

	if (!type_mapper) { throw new Error(`Unsupported db_type: ${db_type}`); }

	let success = true;

	// Load schema from DB structure cache instead of re-introspecting
	const { load_ddl_cache, ddl_cache_to_schema_objects } = await import("./ddl_cache");
	const cache = await load_ddl_cache();
	const { all_schemas, all_indexes } = ddl_cache_to_schema_objects(cache);

	const targets = target === "all" || target === "all-tables" ? all_schemas.filter((o) => o.type === "table" && !o.name.startsWith(INTERNAL_TABLE_PREFIX) && !IGNORE_TABLES.includes(
		o.name as (typeof IGNORE_TABLES)[number]
	) && !o.comment?.toLowerCase().includes("crud-ignore")) : all_schemas.filter((o) => o.name === target);

	if (target === "all" || target === "all-tables") {
		const ignored = all_schemas.filter((o) => o.type === "table" && IGNORE_TABLES.includes(o.name as (typeof IGNORE_TABLES)[number])).map((o) => o.name);

		if (ignored.length) {
			const red = Bun.color("red", "ansi");
			console.log(`${red}Skipping ignored tables: ${ignored.join(", ")}`);
		}

		console.log(`${Bun.color("green", "ansi")}[${db_type.toUpperCase()}] Tables to generate:`, targets.map((t) => t.name).join(", "));
	}

	const table_column_map = build_table_column_map(all_schemas);

	for (const schema_obj of targets) {
		console.log("obj:", schema_obj.name);

		// Detect parent FK relationship when --parent is specified
		if (parent_table) {
			const fk = schema_obj.foreign_keys.find((fk) => fk.referenced_table_name.toLowerCase() === parent_table.toLowerCase());
			if (!fk) {
				console.error(`✗ No foreign key found in ${schema_obj.name} referencing table "${parent_table}".`);
				success = false;
				continue;
			}
			schema_obj.parent = {
				table: parent_table,
				fk_column: fk.column_name,
				route_param: fk.referenced_column_name,
				label: capitalize_label(singularize(parent_table)),
			};
			console.log(`✓ Detected parent "${parent_table}" via FK "${fk.column_name}" → ${fk.referenced_table_name}.${fk.referenced_column_name}`);
		}
		try {
			// Nested children live directly under the parent's directory:
			// routes/<parent>/<child>
			// routes/<prefix>/<parent>/<child>  (when --prefix is also set)
			const dir_name = route_name || schema_obj.name;
			const route_dir = parent_table ? (() => {
				const parent_dir = clean_prefix ? join("routes", clean_prefix, parent_table) : join("routes", parent_table);
				return join(parent_dir, dir_name);
			})() : clean_prefix ? join("routes", clean_prefix, dir_name) : join("routes", dir_name);
			mkdirSync(route_dir, { recursive: true });
			mkdirSync(join(route_dir, "schema"), { recursive: true });

			await write_table_generated_file(
				route_dir,
				schema_obj,
				type_mapper,
				table_column_map,
				all_indexes
			);

			// If --parent is specified, ensure the parent export is in table.ts
			// (write_table_file skips if table.ts already exists, so we inject it here)
			if (parent_table && schema_obj.parent) {
				const table_ts_path = join(route_dir, "schema", "table.ts");
				if (await Bun.file(table_ts_path).exists()) {
					let table_ts_content = await Bun.file(table_ts_path).text();
					if (!table_ts_content.includes("export const parent")) {
						const parent_block = `\n// Parent table configuration for nested CRUD (set via --parent flag).\n// This child table's records belong to a parent record.\n// table: Parent table name\n// fk_column: Foreign key column in this table referencing the parent\n// route_param: URL parameter name for the parent ID in nested routes\nexport const parent = ${JSON.stringify(
							schema_obj.parent,
							null,
							2
						)};\n`;
						table_ts_content = table_ts_content.replace("export { columns, route_param };", `${parent_block}export { columns, route_param };`);
						await Bun.write(table_ts_path, table_ts_content);
						console.log(`✓ Injected parent export into existing table.ts`);
					}
				}
			}

			await write_table_file({
				dir: route_dir,
				schema_obj,
				type_mapper,
				all_tables_columns: table_column_map,
				all_tables_indexes: all_indexes,
				all_schemas,
				pagination_strategy: options.pagination_strategy,
			});
			await write_validation_file(route_dir, schema_obj, type_mapper, table_column_map, all_indexes);
			await write_translation_files(
				route_dir,
				schema_obj,
				type_mapper,
				table_column_map,
				all_indexes,
				route_name
			);

			// Print deduplicated missing-index warnings (collected across all file writes)
			const warnings = get_and_clear_missing_index_warnings();
			for (const warning of warnings) {
				console.warn(warning);
			}

			// Inject scopes translation keys from global_scopes table into all language files
			await inject_scopes_translations(db_cli, route_dir, schema_obj.name);

			await update_route_label_translations(
				db_cli,
				schema_obj.name,
				clean_prefix,
				parent_table,
				route_name
			);

			console.log(`✓ Generated schema for: ${schema_obj.name}`);
		} catch (e) {
			console.log("Failed writing:", e);
			success = false;
		}
	}

	// Nested children should not update root nav (they don't have standalone nav entries)
	if (targets.length > 0 && !parent_table) {
		const table_names = targets.map((t) => t.name);
		await update_root_nav_translations(db_cli, table_names, clean_prefix, route_name);
	}

	// Notify running server to reload translations
	await notify_server_reload();

	return success;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function update_root_nav_translations(db: SQL, table_names: string[], prefix: string = "", route_name: string = ""): Promise<void> {
	for (const name of table_names) {
		const effective = route_name || name;
		const nav_key = prefix ? `${prefix}.${effective}` : effective;
		const label = capitalize_label(effective.replace(/[^a-zA-Z0-9 ]/g, " ").replace(/_/g, " "));
		try {
			await db`DELETE FROM translations WHERE lang = 'en' AND namespace = ${nav_key} AND key_path = 'nav'`;
			await db`INSERT INTO translations (lang, namespace, key_path, translation) VALUES ('en', ${nav_key}, 'nav', ${label})`;
		} catch (err) {
			console.error(`    ❌ Failed to upsert nav ${nav_key}:`, err instanceof Error ? err.message : err);
		}
		console.log(`✓ Updated nav in DB: ${nav_key} = ${label}`);
	}
}

async function update_route_label_translations(
	db: SQL,
	table_name: string,
	prefix: string = "",
	parent_table: string = "",
	route_name: string = "",
): Promise<void> {
	const dir_name = route_name || table_name;
	const route_dir = parent_table ? prefix ? join("routes", prefix, parent_table, dir_name) : join("routes", parent_table, dir_name) : prefix ? join("routes", prefix, dir_name) : join(
		"routes",
		dir_name
	);

	const routes_dir = join(process.cwd(), "routes");
	const rel_path = relative(routes_dir, join(process.cwd(), route_dir));
	const namespace = rel_path.replace(/\\/g, "/")
		.split("/")
		.filter((p) => p !== "translations")
		.join(".");
	const singular = singularize(table_name);
	const label_key = `new_${singular}`;
	const key_path = `actions.${label_key}`;
	const english_value = `New ${capitalize_label(singular)}`;

	try {
		await db`DELETE FROM translations WHERE lang = 'en' AND namespace = ${namespace} AND key_path = ${key_path}`;
		await db`INSERT INTO translations (lang, namespace, key_path, translation) VALUES ('en', ${namespace}, ${key_path}, ${english_value})`;
	} catch (err) {
		console.error(`    ❌ Failed to upsert action ${namespace}:${key_path}:`, err instanceof Error ? err.message : err);
	}
	console.log(`✓ Updated actions in DB: ${namespace}:${key_path} = ${english_value}`);
}

/**
 * Inject scopes translation keys from global_scopes table into DB.
 * Called after write_translation_files to handle existing schemas.
 */
async function inject_scopes_translations(db: SQL, route_dir: string, table_name: string): Promise<void> {
	try {
		const scope_rows = (await db`SELECT scope_key, display_name FROM global_scopes WHERE table_name = ${table_name} ORDER BY sort_order ASC`) as Array<{ scope_key: string; display_name: string; }>;
		if (scope_rows.length === 0) return;

		const routes_dir = join(process.cwd(), "routes");
		const rel_path = relative(routes_dir, route_dir);
		const namespace = rel_path.replace(/\\/g, "/")
			.split("/")
			.filter((p) => p !== "translations")
			.join(".");

		let injected_count = 0;
		for (const row of scope_rows) {
			const key_path = `scopes.${row.scope_key}`;
			try {
				await db`DELETE FROM translations WHERE lang = 'en' AND namespace = ${namespace} AND key_path = ${key_path}`;
				await db`INSERT INTO translations (lang, namespace, key_path, translation) VALUES ('en', ${namespace}, ${key_path}, ${row.display_name})`;
				injected_count++;
			} catch (err) {
				console.error(`    ❌ Failed to upsert scope ${namespace}:${key_path}:`, err instanceof Error ? err.message : err);
			}
		}

		if (injected_count > 0) { console.log(`  ✓ Injected ${scope_rows.length} scope key(s) into DB (namespace: "${namespace}")`); }
	} catch {
		// global_scopes table may not exist yet (first run) - skip silently
	}
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main() {
	// Load DB structure cache at startup
	const { load_ddl_cache } = await import("./ddl_cache");
	await load_ddl_cache();

	const { values, positionals } = parseArgs({
		args: Bun.argv.slice(2),
		options: {
			prefix: { type: "string", default: "" },
			parent: { type: "string", default: "" },
		},
		allowPositionals: true,
		strict: false,
	});

	const arg = positionals[0];
	if (!arg) {
		console.error("Usage: bun generator/schema.ts <table | all | all-tables> [--prefix <dir>] [--parent <table>]");
		process.exit(1);
	}

	const success = await generate_schema(String(arg), { prefix: String(values.prefix ?? ""), parent_table: String(values.parent ?? "") });

	process.exit(success ? 0 : 1);
}

// Only run as CLI when executed directly, not when imported as a module
if (import.meta.path === Bun.main) { main(); }
