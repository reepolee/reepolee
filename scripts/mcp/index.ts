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
 * - read_template_file       Read a .ree template file from routes/ or components/
 * - render_template_file     Render a .ree template file from the project with data
 * ## Project tools
 * - get_project_context      Read the project overview (llms.txt) for full context
 * - list_routes              List all registered routes with metadata
 * - list_templates           List all .ree templates in routes/ and components/
 * - list_translations        List available languages and translation namespaces
 * - get_translations         Get translations for a language and optional namespace
 * - list_config              Show project configuration (DB type, languages, conventions)
 * - list_generators          List available code generators
 * - search_code              Search the codebase with ripgrep
 * - get_route_detail         Get detailed info about a route (handler, template, SQL)
 * - run_generator            Run a code generator
 * - reload_translations      Trigger translation reload on the running server
 * ## Database tools
 * - list_db_tables           List all database tables and views
 * - get_table_structure      Get full schema for a database table (columns, types, keys)
 * - get_db_config            Show database connection details and conventions
 * - run_sql                  Run a read-only SELECT query and return results
 * ## Operations tools
 * - get_queue_status         Show background job queue status
 * - run_tests                Run project tests
 * - check_domain_compliance  Report columns not matching the canonical domain types (read-only)
 * - refresh_crud             Regenerate CRUD for an existing route (full or fields-only)
 * - prune_translations       Find DB translation keys no longer referenced in templates
 * - sync_missing_translations Find translation keys referenced in templates but missing from the DB
 * - add_translations          Insert translation entries directly into the DB and optionally reload
 * - rescan_ddl_cache         Invalidate and re-introspect the DB structure cache
 *
 * Communication: stdio (MCP / JSON-RPC 2.0 protocol)
 * Start: bun run mcp
 */

import { existsSync } from "node:fs";
import TemplateEngine from "$lib/template_engine";
import { create_template_helpers } from "$lib/template_helpers";
import { file } from "bun";

import pkg from "../../package.json";

import { db } from "$config/db";
import { get_db_config, get_table_structure, list_db_tables, run_read_only_query } from "./db";
import {
	add_translations,
	check_domain_compliance,
	get_queue_status,
	prune_translations,
	refresh_crud,
	reload_translations,
	rescan_ddl_cache,
	run_generator,
	run_project_tests,
	sync_missing_translations,
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
import { COMPONENTS_DIR, PROJECT_ROOT, ROUTES_DIR, resolve_template_file } from "./paths";
import { filter_mcp_tools } from "./capabilities";

// ---------------------------------------------------------------------------
// Project setup
// ---------------------------------------------------------------------------

const SERVER_VERSION = pkg.version;

function assert_template_rendering_enabled(): void {
	if (Bun.env.MCP_ENABLE_TEMPLATE_RENDER !== "true") {
		throw new Error("Template rendering executes local code and requires MCP_ENABLE_TEMPLATE_RENDER=true");
	}
}

const engine = new TemplateEngine({
	views: ROUTES_DIR,
	cache: false,
	ext: ".ree",
	auto_escape: true,
});

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

function json_rpc(id: any, result: any): string { return `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`; }

function json_rpc_error(id: any, code: number, message: string, data?: any): string {
	return `${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message, data } })}\n`;
}

function json_rpc_notification(method: string, params?: any): string { return `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`; }

// ---------------------------------------------------------------------------
// Helper: build default template data
// ---------------------------------------------------------------------------

/** Set a nested property by dot-separated key_path. */
function set_nested(obj: Record<string, any>, key_path: string, value: string): void {
	const keys = key_path.split(".");
	let current = obj;
	for (let i = 0; i < keys.length - 1; i++) {
		const key = keys[i];
		if (!current[key] || typeof current[key] !== "object") { current[key] = {}; }
		current = current[key];
	}
	current[keys[keys.length - 1]] = value;
}

// ---------------------------------------------------------------------------
// Template render data
// ---------------------------------------------------------------------------

function default_template_data(userData: Record<string, any>) {
	const data: Record<string, any> = {
		is_dev: false,
		lang: "en",
		locale: "en-US",
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
					description: "Data object to pass to the template (common vars like lang, is_dev, user are auto-injected)",
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
		description: "Read a .ree template file under routes/ or components/.",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Project-relative path under routes/ or components/ (e.g. 'routes/home/index.ree').",
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
		description: "Execute and render a .ree template under routes/ or components/. Requires MCP_ENABLE_TEMPLATE_RENDER=true.",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Project-relative path under routes/ or components/ (e.g. 'routes/home/index.ree').",
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
		description: "List all .ree templates in routes/ and components/ with type (route, component, layout)",
		inputSchema: { type: "object", properties: {} },
		handler: async () => {
			const files = list_all_ree_files();
			return json_content({ files, total: files.length });
		},
	},
	{
		name: "list_translations",
		description: "List available languages and their translation namespaces",
		inputSchema: { type: "object", properties: {} },
		handler: async () => {
			const nsByLang = await list_translation_namespaces();
			return json_content({ languages: nsByLang });
		},
	},
	{
		name: "get_translations",
		description: "Get translations for a language and optional namespace",
		inputSchema: {
			type: "object",
			properties: {
				lang: { type: "string", description: "Language code (e.g. 'en', 'sl')" },
				namespace: {
					type: "string",
					description: "Optional namespace path (e.g. 'home', 'system/auth/login'). If omitted, returns all namespaces for the language.",
				},
			},
			required: ["lang"],
		},
		handler: async (args) => {
			const { lang, namespace } = args;

			if (namespace) {
				const rows = await db`SELECT key_path, translation FROM translations WHERE lang = ${lang} AND namespace = ${namespace} ORDER BY key_path` as {
					key_path: string;
					translation: string;
				}[];

				if (rows.length === 0) { throw new Error(`Translations not found for namespace "${namespace}" in language "${lang}"`); }

				// Reconstruct nested object from flat key_paths
				const result: Record<string, any> = {};
				for (const row of rows) {
					set_nested(result, row.key_path, row.translation);
				}

				return json_content(result);
			}

			// No namespace specified - return all namespaces for the language
			const nsRows = await db`SELECT DISTINCT namespace FROM translations WHERE lang = ${lang} ORDER BY namespace` as { namespace: string; }[];

			if (nsRows.length === 0) { throw new Error(`No translations found for language "${lang}"`); }

			const result: Record<string, any> = {};
			for (const { namespace: ns } of nsRows) {
				const keyRows = await db`SELECT key_path, translation FROM translations WHERE lang = ${lang} AND namespace = ${ns} ORDER BY key_path` as {
					key_path: string;
					translation: string;
				}[];
				const nsKey = ns || "root";
				result[nsKey] = {};
				for (const row of keyRows) {
					set_nested(result[nsKey], row.key_path, row.translation);
				}
			}

			return json_content(result);
		},
	},
	{
		name: "list_config",
		description: "Show project configuration - database type, active languages, conventions, component/route counts",
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
			const maxResults = Math.min(args.max_results || 50, 200);
			const result = await search_code(args.pattern, args.glob, maxResults);
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
		description: "Run a code generator. Available: resource (single-table full pipeline), schema, crud, bulk (many tables), nested (child tables under --parent), sync_translations, add_language, remove_language, user, validation.",
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
			},
			required: ["name"],
		},
		handler: async (args) => {
			const result = await run_generator(args.name, args.args || []);
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
		description: "List all database tables and views with column counts",
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

	//
	// Operations tools
	//
	{
		name: "get_queue_status",
		description: "Show background job queue status - pending, running, delayed, and failed job counts per queue. Requires REDIS_URL.",
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
		description: "Scan .ree templates and find DB translation keys no longer referenced anywhere. Returns the orphan list and stats. Set write_sql to also write a timestamped DELETE .sql file for manual review (never runs it).",
		inputSchema: {
			type: "object",
			properties: {
				write_sql: {
					type: "boolean",
					description: "Also write a DELETE .sql file for the orphaned keys (default false)",
				},
			},
		},
		handler: async (args) => {
			const result = await prune_translations(args.write_sql === true);
			return json_content(result);
		},
	},
	{
		name: "sync_missing_translations",
		description: "Scan .ree templates for translation keys referenced but missing from the database. Returns the missing list and stats. Set write_sql to also write a timestamped INSERT .sql file for manual review (never runs it).",
		inputSchema: {
			type: "object",
			properties: {
				write_sql: {
					type: "boolean",
					description: "Also write an INSERT .sql file for the missing keys (default false)",
				},
			},
		},
		handler: async (args) => {
			const result = await sync_missing_translations(args.write_sql === true);
			return json_content(result);
		},
	},
	{
		name: "add_translations",
		description: "Insert translation entries directly into the database. Skips entries that already exist. Call reload_translations after to activate them.",
		inputSchema: {
			type: "object",
			properties: {
				entries: {
					type: "array",
					description: "Translation entries to insert",
					items: {
						type: "object",
						properties: {
							lang: { type: "string", description: "Language code (e.g. 'en', 'sl')" },
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
						required: ["lang", "namespace", "key_path", "translation"],
					},
				},
			},
			required: ["entries"],
		},
		handler: async (args) => {
			const result = await add_translations(args.entries);
			return json_content(result);
		},
	},
	{
		name: "rescan_ddl_cache",
		description: "Invalidate the DDL cache and re-introspect the full database (detect new tables, columns, and foreign keys). Returns the number of tables detected.",
		inputSchema: { type: "object", properties: {} },
		handler: async () => {
			const result = await rescan_ddl_cache();
			return json_content(result);
		},
	},
];

// Map name -> handler
const exposed_tools = filter_mcp_tools(tools);

const toolMap = new Map();
for (const t of exposed_tools) {
	toolMap.set(t.name, t.handler);
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
				const handler = toolMap.get(name);
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
		case "notifications/exit":
			{ process.exit(0); }
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

	process.stdout.write(json_rpc_notification("server/capabilities", {
		serverInfo: { name: "reepolee", version: SERVER_VERSION },
	}));

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
}

main().catch((err) => {
	console.error("[ree-mcp] Fatal:", err);
	process.exit(1);
});
