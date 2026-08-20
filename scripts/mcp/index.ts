#!/usr/bin/env bun
/**
 * MCP Server for reepolee (Reepolee Bun Apps)
 *
 * Main entry point - wires together the MCP submodules and starts the server.
 *
 * ## Template tools
 * - render_template          Render a .ree template with data, return HTML
 * - validate_template        Check .ree template syntax without rendering
 * - compile_template         Show the generated JavaScript for a .ree template
 * - analyze_template         Extract structure (layouts, includes, components, variables)
 * - list_components          List available .ree components
 * - get_component_source     Read a component's .ree source
 * - read_template_file       Read a .ree template file from the main app, platform/, or components/
 * - render_template_file     Render a .ree template file from the project with data
 * ## Project tools
 * - get_project_context      Read the project overview (llms.txt) for full context
 * - list_routes              List all registered routes with metadata
 * - list_templates           List all .ree templates in the main app, platform/, and components/
 * - list_translations        List available locales and translation namespaces
 * - get_translations         Get translations for a locale and optional namespace
 * - list_config              Show project configuration (DB type, locales, conventions)
 * - list_generators          List available code generators
 * - search_code              Search the codebase with ripgrep
 * - get_route_detail         Get detailed info about a route (handler, template, SQL)
 * - run_generator            Run a code generator, including synthetic BREAD resources
 * - reload_translations      Trigger translation reload on the running server
 * ## Database tools
 * - list_db_tables           List all database tables and views
 * - get_table_structure      Get full schema for a database table (columns, types, keys)
 * - get_db_config            Show database connection details and conventions
 * - run_sql                  Run a read-only SELECT query and return results
 * - run_sql_dev              Run SQL against the dev DB via unsafe(), returns meta + records; read-only by default, allow_changes opts into writes (mutation capability)
 * ## Operations tools
 * - get_queue_status         Show background job queue status
 * - run_tests                Run project tests
 * - check_domain_compliance  Report columns not matching the canonical domain types (read-only)
 * - refresh_crud             Regenerate CRUD for an existing route (full or fields-only)
 * - prune_translations       Find or delete file-backed translation keys no longer referenced
 * - insert_translations      Find or add translation keys missing from locale files
 * - add_translations          Add translation entries directly to locale files
 * - sync_translations         Sync translation data across locales, optionally using AI
 *
 * Communication: stdio (MCP / JSON-RPC 2.0 protocol)
 * Start: bun run mcp
 */

import { existsSync } from "node:fs";
import { DEFAULT_HELPER_NAMES } from "$lib/helper_names";
import { run_sql, run_sql_read_only } from "$lib/sql_runner";
import TemplateEngine from "$lib/template_engine";
import { create_template_helpers } from "$lib/template_helpers";
import { read_all_translation_rows, read_namespace_file } from "$lib/translation_files";
import { file } from "bun";

import pkg from "../../package.json";

import { close_db, db } from "$config/db";
import { close_db_cli } from "$config/db_cli";
import { env_switch_on } from "$config/env_vars";
import { default_locale, locales } from "$config/supported_locales";
import { get_db_config, get_table_structure, list_db_tables, run_read_only_query } from "./db";
import {
	add_translations,
	check_domain_compliance,
	get_queue_status,
	prune_translations,
	refresh_crud,
	reload_translations,
	run_generator,
	run_project_tests,
	insert_translations,
	sync_translations,
} from "./operations";
import {
	analyze_template,
	get_project_config,
	get_route_detail,
	list_all_ree_files,
	list_components,
	list_generators,
	list_route_paths,
	list_translation_namespaces,
	read_project_file,
	search_code,
} from "./project";
import { COMPONENTS_DIR, PLATFORM_ROOT, PROJECT_ROOT, ROUTES_DIR, resolve_template_file } from "./paths";
import { filter_mcp_tools } from "./capabilities";

// ---------------------------------------------------------------------------
// Project setup
// ---------------------------------------------------------------------------

const SERVER_VERSION = pkg.version;
let shutdown_promise: Promise<void> | null = null;

function shutdown_mcp_server(): Promise<void> {
	if (shutdown_promise) return shutdown_promise;
	shutdown_promise = (async () => {
		await Promise.allSettled([close_db_cli(), close_db()]);
	})();
	return shutdown_promise;
}

function assert_template_rendering_enabled(): void {
	if (!env_switch_on("MCP_ENABLE_TEMPLATE_RENDER")) {
		throw new Error("Template rendering executes local code and requires MCP_ENABLE_TEMPLATE_RENDER=true");
	}
}

const engine = new TemplateEngine({
	views: ROUTES_DIR,
	shared_views: PLATFORM_ROOT,
	project_root: PROJECT_ROOT,
	cache: false,
	ext: ".ree",
	auto_escape: true,
	locales,
	default_locale,
	helper_names: DEFAULT_HELPER_NAMES,
});

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

function json_rpc(id: any, result: any): string { return `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`; }

function json_rpc_error(id: any, code: number, message: string, data?: any): string {
	return `${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message, data } })}\n`;
}

// ---------------------------------------------------------------------------
// Helper: build default template data
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Template render data
// ---------------------------------------------------------------------------

function default_template_data(userData: Record<string, any>) {
	const data: Record<string, any> = {
		is_dev: false,
		locale: "en-us",
		user: null,
		site_name: "reepolee App",
		year: Number(Temporal.Now.instant().toString().slice(0, 4)),
		...userData,
	};
	// Reuse the canonical template helpers so MCP-rendered previews match the app.
	// Context-dependent helpers (localized_path, is_current) degrade gracefully to
	// identity behavior here since the route map and request context are not built.
	const custom_helpers = userData.helpers || {};
	data.helpers = create_template_helpers(data, custom_helpers);
	return data;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

type ToolHandler = (args: Record<string, any>) => Promise<any>;

/** Wrap raw text as an MCP tool result. */
function text_content(text: string) { return { content: [{ type: "text", text }] }; }

/** Wrap a value as a pretty-printed JSON MCP tool result. */
function json_content(value: any) { return text_content(JSON.stringify(value, null, 2)); }

const tools: Array<{ name: string; description: string; inputSchema: Record<string, any>; handler: ToolHandler; }> = [
	//
	// Template tools
	//
	{
		name: "render_template",
		description: "Execute and render a .ree template string locally. Requires MCP_ENABLE_TEMPLATE_RENDER=true.",
		inputSchema: {
			type: "object",
			properties: {
				template: { type: "string", description: "The .ree template content to render" },
				data: {
					type: "object",
					description: "Data object to pass to the template (common vars like locale, is_dev, user are auto-injected)",
					additionalProperties: true,
				},
			},
			required: ["template"],
		},
		handler: async (args) => {
			assert_template_rendering_enabled();
			const html = await engine.render_string(args.template, default_template_data(args.data || {}));
			return text_content(html);
		},
	},
	{
		name: "validate_template",
		description: "Validate .ree template syntax without rendering - returns valid flag and any errors",
		inputSchema: {
			type: "object",
			properties: {
				template: { type: "string", description: "The .ree template content to validate" },
			},
			required: ["template"],
		},
		handler: async (args) => {
			try {
				engine.compile_to_code(args.template);
				return text_content(JSON.stringify({ valid: true, errors: [] }));
			} catch (e: any) {
				return text_content(JSON.stringify({ valid: false, errors: [e.message] }));
			}
		},
	},
	{
		name: "compile_template",
		description: "Compile a .ree template and show the generated JavaScript source code",
		inputSchema: {
			type: "object",
			properties: {
				template: { type: "string", description: "The .ree template content to compile" },
			},
			required: ["template"],
		},
		handler: async (args) => {
			try {
				const { code } = engine.compile_to_code(args.template);
				return text_content(code);
			} catch (e: any) {
				return text_content(`// Compilation error:\n// ${e.message}`);
			}
		},
	},
	{
		name: "analyze_template",
		description: "Analyze a .ree template and extract its structure - layout, includes, components, variables, conditionals, loops",
		inputSchema: {
			type: "object",
			properties: {
				template: { type: "string", description: "The .ree template content to analyze" },
			},
			required: ["template"],
		},
		handler: async (args) => {
			const analysis = analyze_template(args.template);
			return json_content(analysis);
		},
	},
	{
		name: "list_components",
		description: "List all available .ree component files in the components directory",
		inputSchema: { type: "object", properties: {} },
		handler: async () => {
			const components = list_components();
			return json_content({ components });
		},
	},
	{
		name: "get_component_source",
		description: "Read the source of a .ree component by name",
		inputSchema: {
			type: "object",
			properties: { name: { type: "string", description: "Component name (without .ree extension)" } },
			required: ["name"],
		},
		handler: async (args) => {
			const component_path = resolve_template_file(`components/${args.name}.ree`);
			if (!existsSync(component_path)) { throw new Error(`Component "${args.name}" not found`); }
			const source = await file(component_path).text();
			return text_content(source);
		},
	},
	{
		name: "read_template_file",
		description: "Read a .ree template file under the main app, platform/, or components/.",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Project-relative path under the main app, platform/, or components/ (e.g. 'apps/main/home/index.ree').",
				},
			},
			required: ["path"],
		},
		handler: async (args) => {
			const template_path = resolve_template_file(args.path);
			if (!existsSync(template_path)) { throw new Error(`Template file not found: ${args.path}`); }
			const source = await file(template_path).text();
			return text_content(source);
		},
	},
	{
		name: "render_template_file",
		description: "Execute and render a .ree template under the main app, platform/, or components/. Requires MCP_ENABLE_TEMPLATE_RENDER=true.",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Project-relative path under the main app, platform/, or components/ (e.g. 'apps/main/home/index.ree').",
				},
				data: {
					type: "object",
					description: "Data object to pass to the template",
					additionalProperties: true,
				},
			},
			required: ["path"],
		},
		handler: async (args) => {
			assert_template_rendering_enabled();
			const template_path = resolve_template_file(args.path);
			if (!existsSync(template_path)) { throw new Error(`Template file not found: ${args.path}`); }
			const template = await file(template_path).text();
			const html = await engine.render_string(template, default_template_data(args.data || {}));
			return text_content(html);
		},
	},

	//
	// Project tools
	//
	{
		name: "get_project_context",
		description: "Read the project llms.txt for full context - project overview, architecture, commands, generators, conventions",
		inputSchema: { type: "object", properties: {} },
		handler: async () => {
			const text = await read_project_file("llms.txt");
			if (!text) { throw new Error("llms.txt not found at project root. Run `bun run mcp` from the reepolee project directory."); }
			return text_content(text);
		},
	},
	{
		name: "list_routes",
		description: "List all registered routes with metadata (URL, type, module)",
		inputSchema: { type: "object", properties: {} },
		handler: async () => {
			const routes = list_route_paths();
			return json_content({ routes, total: routes.length });
		},
	},
	{
		name: "list_templates",
		description: "List all .ree templates in the main app, platform/, and components/ with type (route, component, layout)",
		inputSchema: { type: "object", properties: {} },
		handler: async () => {
			const files = list_all_ree_files();
			return json_content({ files, total: files.length });
		},
	},
	{
		name: "list_translations",
		description: "List available locales and their translation namespaces",
		inputSchema: { type: "object", properties: {} },
		handler: async () => {
			const ns_by_locale = await list_translation_namespaces();
			return json_content({ locales: ns_by_locale });
		},
	},
	{
		name: "get_translations",
		description: "Get translations for a locale and optional namespace",
		inputSchema: {
			type: "object",
			properties: {
				locale: { type: "string", description: "Locale code (e.g. 'en-us', 'sl-si')" },
				namespace: {
					type: "string",
					description: "Optional namespace path (e.g. 'home', 'system/auth/login'). If omitted, returns all namespaces for the locale.",
				},
			},
			required: ["locale"],
		},
		handler: async (args) => {
			const { locale, namespace } = args;

			if (namespace) {
				const normalized_namespace = String(namespace).replaceAll("/", ".");
				const result = await read_namespace_file(normalized_namespace, String(locale));
				if (Object.keys(result).length === 0) { throw new Error(`Translations not found for namespace "${namespace}" in locale "${locale}"`); }
				return json_content(result);
			}

			// No namespace specified - return all namespaces for the locale
			const rows = await read_all_translation_rows();
			const locale_rows = rows.filter((row) => row.locale === locale);
			const namespaces = [...new Set(locale_rows.map((row) => row.namespace))].sort();
			if (namespaces.length === 0) { throw new Error(`No translations found for locale "${locale}"`); }
			const result: Record<string, any> = {};
			for (const namespace_name of namespaces) {
				result[namespace_name] = await read_namespace_file(namespace_name, String(locale));
			}

			return json_content(result);
		},
	},
	{
		name: "list_config",
		description: "Show project configuration - database type, active locales, conventions, component/route counts",
		inputSchema: { type: "object", properties: {} },
		handler: async () => {
			const config = await get_project_config();
			return json_content(config);
		},
	},
	{
		name: "list_generators",
		description: "List available code generators with names, files, and descriptions",
		inputSchema: { type: "object", properties: {} },
		handler: async () => {
			const generators = list_generators();
			return json_content({ generators, total: generators.length });
		},
	},
	{
		name: "search_code",
		description: "Search authored project code with ripgrep. Secrets, VCS metadata, dependencies, and archives are excluded.",
		inputSchema: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "Search pattern (supports regex)" },
				glob: {
					type: "string",
					description: "Optional file glob filter (e.g. '*.ts', '*.ree', '*.json')",
				},
				max_results: { type: "number", description: "Optional max results (default 50, max 200)" },
			},
			required: ["pattern"],
		},
		handler: async (args) => {
			const max_results = Math.min(args.max_results || 50, 200);
			const result = await search_code(args.pattern, args.glob, max_results);
			return json_content(result);
		},
	},
	{
		name: "get_route_detail",
		description: "Get detailed information about a route - lists which files exist (index.ts, index.ree, form.ree, sql.ts, etc.)",
		inputSchema: {
			type: "object",
			properties: {
				url: {
					type: "string",
					description: "Route URL path (e.g. '/login', '/system/users', '/examples/about')",
				},
			},
			required: ["url"],
		},
		handler: async (args) => {
			const result = await get_route_detail(args.url);
			return json_content(result);
		},
	},
	{
		name: "run_generator",
		description: "Run a code generator. Available: resource (single-table full pipeline), schema, crud, create_bread (single-content synthetic non-DB BREAD resource - store.ts stub), create_localized_bread (same, but the store is expected to hold content per locale), bulk (many tables), nested (child tables under --parent), sync_translations, install_locale (install an archived locale from locales-archive/, no AI), add_locale, remove_locale, sync_locale_tables (reconcile per-locale clone tables), user, validation.",
		inputSchema: {
			type: "object",
			properties: {
				name: {
					type: "string",
					description: "Generator name (e.g. 'resource', 'crud', 'sync_translations')",
				},
				args: {
					type: "array",
					items: { type: "string" },
					description: "CLI arguments to pass to the generator",
				},
				synthetic_schema: {
					type: "object",
					description: "Required for create_bread/create_localized_bread. Synthetic table schema with columns and exactly one primary-key id column.",
					additionalProperties: true,
				},
			},
			required: ["name"],
		},
		handler: async (args) => {
			const result = await run_generator(args.name, args.args || [], args.synthetic_schema);
			return json_content(result);
		},
	},
	{
		name: "reload_translations",
		description: "Trigger translation reload on the running dev/prod server. Call this after generators that modify translations.",
		inputSchema: { type: "object", properties: {} },
		handler: async () => {
			const result = await reload_translations();
			return json_content(result);
		},
	},

	//
	// Database tools
	//
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

	//
	// Operations tools
	//
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

// Map name -> handler
const exposed_tools = filter_mcp_tools(tools);

const tool_map = new Map();
for (const t of exposed_tools) {
	tool_map.set(t.name, t.handler);
}

function get_tool_schemas() { return exposed_tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })); }

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

async function handle_message(msg: any): Promise<void> {
	const { jsonrpc, id, method, params } = msg;

	if (jsonrpc !== "2.0") {
		if (id) console.error(json_rpc_error(id, -32600, "Invalid Request: not JSON-RPC 2.0"));
		return;
	}

	switch (method) {
		case "initialize":
			{
				const response = json_rpc(id, {
					protocolVersion: "2024-11-05",
					capabilities: { tools: {} },
					serverInfo: { name: "reepolee", version: SERVER_VERSION },
				});
				process.stdout.write(response);
				break;
			}
		case "notifications/initialized":
			{
				// No-op - client confirmed initialization
				break;
			}
		case "tools/list":
			{
				const response = json_rpc(id, { tools: get_tool_schemas() });
				process.stdout.write(response);
				break;
			}
		case "tools/call":
			{
				const { name, arguments: args } = params || {};
				const handler = tool_map.get(name);
				if (!handler) {
					process.stdout.write(json_rpc_error(id, -32601, `Tool not found: ${name}`));
					break;
				}
				try {
					const result = await handler(args || {});
					process.stdout.write(json_rpc(id, result));
				} catch (e: any) {
					process.stdout.write(json_rpc_error(id, -32603, `Tool error: ${e.message}`, { stack: e.stack }));
				}
				break;
			}
		case "notifications/cancelled":
			{
				break;
			}
		case "notifications/exit":
			{
				await shutdown_mcp_server();
				process.exit(0);
			}
		default:
			{
				if (id) { process.stdout.write(json_rpc_error(id, -32601, `Method not found: ${method}`)); }
				break;
			}
	}
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function main() {
	console.error(`[ree-mcp] Project root: ${PROJECT_ROOT}`);
	console.error(`[ree-mcp] Components: ${COMPONENTS_DIR}`);
	console.error(`[ree-mcp] Views: ${ROUTES_DIR}`);
	console.error(`[ree-mcp] Components loaded: ${list_components().length}`);
	console.error(`[ree-mcp] Tools registered: ${exposed_tools.length}`);

	const decoder = new TextDecoder();
	let leftover = "";

	for await (const chunk of Bun.stdin.stream()) {
		const text = decoder.decode(chunk, { stream: true });
		const parts = (leftover + text).split("\n");
		leftover = parts.pop() || "";

		for (const part of parts) {
			const trimmed = part.trim();
			if (!trimmed) continue;
			try {
				const msg = JSON.parse(trimmed);
				await handle_message(msg);
			} catch (e: any) {
				console.error(`[ree-mcp] Parse error: ${e.message}`);
			}
		}
	}

	await shutdown_mcp_server();
}

main().catch((err) => {
	console.error("[ree-mcp] Fatal:", err);
	shutdown_mcp_server().finally(() => process.exit(1));
});
