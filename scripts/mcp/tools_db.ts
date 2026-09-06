/**
 * Database MCP tools - schema introspection and read-only SQL execution.
 * run_sql_dev additionally exposes writes to the dev DB behind
 * MCP_ENABLE_MUTATIONS=true (see ./capabilities).
 */
import { run_sql, run_sql_read_only } from "$lib/sql_runner";

import { get_db_config, get_table_structure, list_db_tables, run_read_only_query } from "./db";
import { json_content } from "./tools_common";
import type { Tool } from "./tools_common";

export const db_tools: Tool[] = [
	{
		name: "list_db_tables",
		description: "List all database tables and views with column counts. A table carrying locale_clone_of is a per-locale clone of that base table - it is maintained by the sync_locale_tables generator and must never be written directly; write to the base table instead, which fans the write out to every clone.",
		inputSchema: { type: "object", properties: {} },
		handler: async () => {
			const tables = await list_db_tables();
			return json_content({ tables, total: tables.length });
		},
	},
	{
		name: "get_table_structure",
		description: "Get full schema for a database table or view - columns, types, nullable, primary keys, auto-increment, defaults, foreign keys",
		inputSchema: {
			type: "object",
			properties: {
				table: {
					type: "string",
					description: "Table or view name (e.g. 'frameworks', 'users', 'v_frameworks')",
				},
			},
			required: ["table"],
		},
		handler: async (args) => {
			const info = await get_table_structure(args.table);
			return json_content(info);
		},
	},
	{
		name: "get_db_config",
		description: "Show database connection details and naming conventions (type, timezone, maintenance fields, suffixes, ignored tables)",
		inputSchema: { type: "object", properties: {} },
		handler: async () => {
			const config = get_db_config();
			return json_content(config);
		},
	},
	{
		name: "run_sql",
		description: "Run one read-only SELECT query and return results. Results are capped at 100 rows by default.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "SQL query to execute (read-only)" },
				limit: { type: "number", description: "Optional max rows (default 100, max 1000)" },
			},
			required: ["query"],
		},
		handler: async (args) => {
			const limit = Math.min(args.limit || 100, 1000);
			const result = await run_read_only_query(args.query, limit);
			return json_content(result);
		},
	},
	{
		name: "run_sql_dev",
		description: "Execute SQL against the app's dev database via bun:sql unsafe(), returning { meta, records }. Read-only by default (single SELECT per statement, records capped); pass allow_changes=true to permit writes/DDL. Only exposed with MCP_ENABLE_MUTATIONS=true. Use run_sql for read-only inspection.",
		inputSchema: {
			type: "object",
			properties: {
				sql: { type: "string", description: "SQL to execute" },
				allow_changes: { type: "boolean", description: "Permit write statements and DDL (default false - read-only)" },
				limit: { type: "number", description: "Optional cap on returned records (default 100, max 1000)" },
			},
			required: ["sql"],
		},
		handler: async (args) => {
			if (args.allow_changes === true) {
				const result = await run_sql(String(args.sql));
				const limit = Math.min(Math.max(Math.floor(args.limit || 100), 1), 1000);
				const records = result.records.slice(0, limit);
				const truncated = result.records.length > limit;
				return json_content({ meta: { ...result.meta, record_count: records.length }, records, truncated });
			}
			return json_content(await run_sql_read_only(String(args.sql), undefined, args.limit));
		},
	},
];
