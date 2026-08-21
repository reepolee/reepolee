/**
 * Operations MCP tools - queue status, test runs, CRUD refresh, domain
 * compliance, and translation maintenance.
 */
import {
	add_translations,
	check_domain_compliance,
	get_queue_status,
	insert_translations,
	prune_translations,
	refresh_crud,
	run_project_tests,
	sync_translations,
} from "./operations";
import { json_content } from "./tools_common";
import type { Tool } from "./tools_common";

export const operations_tools: Tool[] = [
	{
		name: "get_queue_status",
		description: "Show background job queue status - pending and failed job counts per queue plus worker liveness. Works with the SQL or Redis store.",
		inputSchema: { type: "object", properties: {} },
		handler: async () => {
			const result = await get_queue_status();
			return json_content(result);
		},
	},
	{
		name: "run_tests",
		description: "Run project tests with bun test. Optionally filter by test name pattern. Results include stdout and stderr.",
		inputSchema: {
			type: "object",
			properties: {
				filter: {
					type: "string",
					description: "Optional test name filter (e.g. 'rate_limit', 'template')",
				},
				timeout: { type: "number", description: "Optional timeout in seconds (default 120)" },
			},
		},
		handler: async (args) => {
			const result = await run_project_tests(args.filter, args.timeout || 120);
			return json_content(result);
		},
	},
	{
		name: "check_domain_compliance",
		description: "Introspect the live database and report columns whose SQL type does not match the canonical DOMAIN_TYPES taxonomy. Read-only - never alters the database.",
		inputSchema: { type: "object", properties: {} },
		handler: async () => {
			const result = await check_domain_compliance();
			return json_content(result);
		},
	},
	{
		name: "refresh_crud",
		description: "Regenerate CRUD files for a table that already has a schema folder. Use refresh_fields to update only .ree field sections (preserves layout customizations); otherwise a full force-overwrite of generated files.",
		inputSchema: {
			type: "object",
			properties: {
				table: { type: "string", description: "Table name to refresh CRUD for" },
				prefix: { type: "string", description: "Optional route prefix/module folder" },
				parent: { type: "string", description: "Optional parent table (for nested child routes)" },
				route_name: {
					type: "string",
					description: "Optional route name when it differs from the table name",
				},
				refresh_fields: {
					type: "boolean",
					description: "Only refresh .ree field sections instead of a full overwrite (default false)",
				},
				translate: { type: "boolean", description: "Translate missing keys via AI (default false)" },
			},
			required: ["table"],
		},
		handler: async (args) => {
			const result = await refresh_crud(args.table, {
				prefix: args.prefix,
				parent_table: args.parent,
				route_name: args.route_name,
				refresh_fields: args.refresh_fields,
				translate: args.translate,
			});
			return json_content(result);
		},
	},
	{
		name: "prune_translations",
		description: "Scan .ree templates and find file-backed translation keys no longer referenced. Set apply_changes to delete them from locale files.",
		inputSchema: {
			type: "object",
			properties: {
				apply_changes: {
					type: "boolean",
					description: "Delete orphaned keys from locale files (default false)",
				},
			},
		},
		handler: async (args) => {
			const result = await prune_translations(args.apply_changes === true);
			return json_content(result);
		},
	},
	{
		name: "insert_translations",
		description: "Scan .ree templates for translation keys missing from locale files. Set apply_changes to add them.",
		inputSchema: {
			type: "object",
			properties: {
				apply_changes: {
					type: "boolean",
					description: "Add missing keys to locale files (default false)",
				},
			},
		},
		handler: async (args) => {
			const result = await insert_translations(args.apply_changes === true);
			return json_content(result);
		},
	},
	{
		name: "sync_translations",
		description: "Sync translation data across all namespace files. Set translate to true to translate missing values with the configured AI provider.",
		inputSchema: {
			type: "object",
			properties: {
				translate: { type: "boolean", description: "Translate missing values using the configured AI provider (default false)" },
			},
		},
		handler: async (args) => {
			const result = await sync_translations(args.translate === true);
			return json_content(result);
		},
	},
	{
		name: "add_translations",
		description: "Add translation entries directly to locale files. Skips entries that already exist and reports incomplete locale-specific groups. Call reload_translations after to activate them.",
		inputSchema: {
			type: "object",
			properties: {
				entries: {
					type: "array",
					description: "Translation entries to insert",
					items: {
						type: "object",
						properties: {
							locale: { type: "string", description: "Locale code (e.g. 'en-us', 'sl-si')" },
							namespace: {
								type: "string",
								description: "Namespace (e.g. 'brands', 'system/users')",
							},
							key_path: {
								type: "string",
								description: "Dot-separated key path (e.g. 'labels.name')",
							},
							translation: { type: "string", description: "Translated text" },
						},
						required: ["locale", "namespace", "key_path", "translation"],
					},
				},
				require_complete_groups: {
					type: "boolean",
					description: "Reject the entire batch before writing when a populated translation group would be incomplete or contain empty values",
				},
			},
			required: ["entries"],
		},
		handler: async (args) => {
			const result = await add_translations(args.entries, args.require_complete_groups === true);
			return json_content(result);
		},
	},
];
