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

import { DEFAULT_HELPER_NAMES } from "$lib/helper_names";
import TemplateEngine from "$lib/template_engine";
import { create_template_helpers } from "$lib/template_helpers";

import pkg from "../../package.json";

import { close_db } from "$config/db";
import { close_db_cli } from "$config/db_cli";
import { env_switch_on } from "$config/env_vars";
import { default_locale, locales } from "$config/supported_locales";
import { list_components } from "./project";
import { COMPONENTS_DIR, PLATFORM_ROOT, PROJECT_ROOT, ROUTES_DIR } from "./paths";
import { filter_mcp_tools } from "./capabilities";
import { template_tools } from "./tools_template";
import { project_tools } from "./tools_project";
import { db_tools } from "./tools_db";
import { operations_tools } from "./tools_operations";

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

const tools = [
	...template_tools({ engine, default_template_data, assert_template_rendering_enabled }),
	...project_tools,
	...db_tools,
	...operations_tools,
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
