#!/usr/bin/env bun

import { join } from "node:path";

import { get_connection_string } from "$lib/env";

export interface StudioInstallerDatabase {
	execute(sql: string): Promise<void>;
	close(): Promise<void>;
}

export interface StudioInstallerOptions {
	connection_string?: string;
	database?: StudioInstallerDatabase;
	module_root?: string;
}

export async function install_studio(options: StudioInstallerOptions = {}): Promise<void> {
	const connection_string = options.connection_string ?? get_connection_string("DEV");
	const normalized_connection = connection_string.toLowerCase();
	const dialect = normalized_connection.startsWith("mysql://") ? "mysql" : "sqlite";
	const module_root = options.module_root ?? import.meta.dir;

	const database = options.database ?? await create_installer_database();
	const owns_database = options.database === undefined;
	const sql_names = ["02-init-translations-en-us.sql", "03-init-translations-sl-si.sql"];

	try {
		for (const sql_name of sql_names) {
			const sql_path = join(module_root, "sql", dialect, sql_name);
			const sql_file = Bun.file(sql_path);
			if (!(await sql_file.exists())) {
				throw new Error(`Studio SQL file not found: ${sql_path}`);
			}

			const sql = await sql_file.text();
			await database.execute(sql);
			console.log(`[studio] Executed ${sql_name}`);
		}
	} finally {
		if (owns_database) { await database.close(); }
	}
}

async function create_installer_database(): Promise<StudioInstallerDatabase> {
	const db_module = await import("$config/db_cli");
	const db_cli = db_module.db_cli;
	return {
		execute: async (sql: string): Promise<void> => {
			await db_cli.unsafe(sql);
		},
		close: db_module.close_db_cli,
	};
}

if (import.meta.main) {
	await install_studio();
}
