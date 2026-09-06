/**
 * Shared types and result-wrapping helpers for MCP tool definitions.
 */

export type ToolHandler = (args: Record<string, any>) => Promise<any>;

export interface Tool {
	name: string;
	description: string;
	inputSchema: Record<string, any>;
	handler: ToolHandler;
}

/** Wrap raw text as an MCP tool result. */
export function text_content(text: string) { return { content: [{ type: "text", text }] }; }

/** Wrap a value as a pretty-printed JSON MCP tool result. */
export function json_content(value: any) { return text_content(JSON.stringify(value, null, 2)); }
