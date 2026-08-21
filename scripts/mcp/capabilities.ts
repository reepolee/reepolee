import { env_switch_on } from "$config/env_vars";

const MUTATION_TOOL_NAMES = new Set([
	"add_translations",
	"refresh_crud",
	"reload_translations",
	"run_generator",
	"prune_translations",
	"insert_translations",
	"sync_translations",
	"spreadsheet_to_sql",
	"run_sql_dev",
]);

export function has_mcp_mutation_capability(value = Bun.env.MCP_ENABLE_MUTATIONS): boolean {
	return env_switch_on("MCP_ENABLE_MUTATIONS", { MCP_ENABLE_MUTATIONS: value });
}

export function assert_mcp_mutation_enabled(value = Bun.env.MCP_ENABLE_MUTATIONS): void {
	if (!has_mcp_mutation_capability(value)) {
		throw new Error("MCP mutations require MCP_ENABLE_MUTATIONS=true for this local process");
	}
}

export function filter_mcp_tools<T extends { name: string; }>(tools: T[], mutation_capability = Bun.env.MCP_ENABLE_MUTATIONS): T[] {
	if (has_mcp_mutation_capability(mutation_capability)) { return tools; }
	return tools.filter((tool) => !MUTATION_TOOL_NAMES.has(tool.name));
}
