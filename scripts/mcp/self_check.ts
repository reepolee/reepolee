#!/usr/bin/env bun

import { PROJECT_ROOT } from "./paths";

type JsonRpcMessage = {
	id?: number;
	result?: { tools?: Array<{ name: string; }>; };
};

const mutations_enabled = process.argv.includes("--mutations");
const notification_exit = process.argv.includes("--notification-exit");
const child = Bun.spawn(["bun", "run", "mcp"], {
	cwd: PROJECT_ROOT,
	env: {
		...process.env,
		MCP_STDIO: "true",
		MCP_ENABLE_MUTATIONS: mutations_enabled ? "true" : "false",
	},
	stdin: "pipe",
	stdout: "pipe",
	stderr: "pipe",
});

const requests: Array<Record<string, any>> = [
	{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "mcp-self-check", version: "1" } } },
	{ jsonrpc: "2.0", method: "notifications/initialized", params: {} },
	{ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
];
if (notification_exit) requests.push({ jsonrpc: "2.0", method: "notifications/exit", params: {} });
for (const request of requests) {
	child.stdin.write(`${JSON.stringify(request)}\n`);
}
child.stdin.end();

const stdout_promise = new Response(child.stdout).text();
const stderr_promise = new Response(child.stderr).text();
const timeout_promise = new Promise<never>((_, reject) => {
	setTimeout(() => reject(new Error("MCP self-check timed out during shutdown")), 10_000);
});

try {
	const exit_code = await Promise.race([child.exited, timeout_promise]);
	const stdout = await stdout_promise;
	const stderr = await stderr_promise;
	if (exit_code !== 0) throw new Error(`MCP exited with code ${exit_code}: ${stderr}`);

	const lines = stdout.split(/\r?\n/);
	const non_empty_lines = lines.filter((line) => line.trim().length > 0);
	const messages: JsonRpcMessage[] = [];
	for (const line of non_empty_lines) {
		try {
			messages.push(JSON.parse(line));
		} catch {
			throw new Error(`Non-JSON content found on MCP stdout: ${line}`);
		}
	}
	const tools_message = messages.find((message) => message.id === 2);
	const tool_names = tools_message?.result?.tools?.map((tool) => tool.name) ?? [];
	const has_mutation_tool = tool_names.includes("run_generator") && tool_names.includes("add_translations");
	if (has_mutation_tool !== mutations_enabled) {
		throw new Error(`Mutation visibility mismatch. expected=${mutations_enabled} actual=${has_mutation_tool}`);
	}
	const result = {
		success: true,
		profile: mutations_enabled ? "mutations" : "read-only",
		json_rpc_frames: messages.length,
		tools: tool_names.length,
		clean_shutdown: true,
		shutdown_mode: notification_exit ? "notifications/exit" : "stdin EOF",
		stderr_diagnostics: stderr.trim().length > 0,
	};
	console.log(JSON.stringify(result, null, 2));
} catch (error) {
	child.kill();
	throw error;
}
