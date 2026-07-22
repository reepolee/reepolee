const MUTATION_TOOL_NAMES = new Set([
	"add_translations",
	"refresh_crud",
	"reload_translations",
	"rescan_ddl_cache",
	"run_generator",
	"prune_translations",
	"sync_missing_translations",
]);

export function has_mcp_mutation_capability(value = Bun.env.MCP_ENABLE_MUTATIONS): boolean {
	return value === "true";
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
