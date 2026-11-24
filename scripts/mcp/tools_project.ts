/**
 * Project MCP tools - context, routes, templates, translations, config,
 * generators, code search, and route details.
 */
import { read_all_translation_rows, read_namespace_file } from "$lib/translation_files";

import {
	get_project_config,
	get_route_detail,
	list_all_ree_files,
	list_generators,
	list_route_paths,
	list_translation_namespaces,
	read_project_file,
	search_code,
} from "./project";
import { run_generator, reload_translations } from "./operations";
import { json_content, text_content } from "./tools_common";
import type { Tool } from "./tools_common";

export const project_tools: Tool[] = [
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
];
