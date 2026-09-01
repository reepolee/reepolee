#!/usr/bin/env bun

import { PROJECT_ROOT } from "./paths";

const port = 24_800 + (process.pid % 800);
const token = "reepolee-mcp-http-self-check-token";
const base_url = `http://127.0.0.1:${port}`;
const child = Bun.spawn(["bun", "scripts/mcp/http.ts"], {
	cwd: PROJECT_ROOT,
	env: {
		...process.env,
		MCP_HTTP_PORT: String(port),
		MCP_HTTP_TOKEN: token,
		MCP_ENABLE_MUTATIONS: "false",
	},
	stdin: "ignore",
	stdout: "pipe",
	stderr: "pipe",
});

const stdout_promise = new Response(child.stdout).text();
const stderr_promise = new Response(child.stderr).text();

async function wait_for_health(): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			const response = await fetch(`${base_url}/health`);
			if (response.ok) return;
		} catch {
			// Server is still starting.
		}
		await Bun.sleep(50);
	}
	throw new Error("MCP HTTP self-check timed out waiting for /health");
}

const mcp_headers = {
	Accept: "application/json, text/event-stream",
	Authorization: `Bearer ${token}`,
	"Content-Type": "application/json",
};

async function post_message(message: Record<string, any>, session_id?: string, protocol_version?: string): Promise<Response> {
	const headers = new Headers(mcp_headers);
	if (session_id) headers.set("Mcp-Session-Id", session_id);
	if (protocol_version) headers.set("MCP-Protocol-Version", protocol_version);
	return await fetch(`${base_url}/mcp`, { method: "POST", headers, body: JSON.stringify(message) });
}

async function initialize_client(id: number): Promise<{ session_id: string; protocol_version: string; }> {
	const response = await post_message({
		jsonrpc: "2.0",
		id,
		method: "initialize",
		params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: `http-self-check-${id}`, version: "1" } },
	});
	if (!response.ok) throw new Error(`Initialize failed: ${response.status} ${await response.text()}`);
	const session_id = response.headers.get("Mcp-Session-Id");
	if (!session_id) throw new Error("Initialize response omitted Mcp-Session-Id");
	const message: any = await response.json();
	const protocol_version = message.result?.protocolVersion;
	if (protocol_version !== "2025-06-18") throw new Error(`Unexpected protocol version: ${protocol_version}`);

	const initialized = await post_message({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, session_id, protocol_version);
	if (initialized.status !== 202) throw new Error(`Initialized notification returned ${initialized.status}`);
	return { session_id, protocol_version };
}

try {
	await wait_for_health();

	const unauthorized = await fetch(`${base_url}/mcp`, { method: "POST", headers: { Accept: mcp_headers.Accept, "Content-Type": "application/json" }, body: "{}" });
	if (unauthorized.status !== 401) throw new Error(`Unauthorized request returned ${unauthorized.status}`);

	const forbidden_headers = new Headers(mcp_headers);
	forbidden_headers.set("Origin", "http://example.com");
	const forbidden = await fetch(`${base_url}/mcp`, { method: "POST", headers: forbidden_headers, body: "{}" });
	if (forbidden.status !== 403) throw new Error(`Foreign origin returned ${forbidden.status}`);

	const [client_one, client_two] = await Promise.all([initialize_client(1), initialize_client(2)]);
	const list_request = (id: number, client: { session_id: string; protocol_version: string; }) => post_message(
		{ jsonrpc: "2.0", id, method: "tools/list", params: {} },
		client.session_id,
		client.protocol_version,
	);
	const [list_one, list_two] = await Promise.all([list_request(3, client_one), list_request(4, client_two)]);
	if (!list_one.ok || !list_two.ok) throw new Error(`Concurrent tools/list failed: ${list_one.status}, ${list_two.status}`);
	const messages: any[] = await Promise.all([list_one.json(), list_two.json()]);
	const message_one = messages[0];
	const message_two = messages[1];
	const tool_count_one = message_one.result?.tools?.length ?? 0;
	const tool_count_two = message_two.result?.tools?.length ?? 0;
	if (tool_count_one === 0 || tool_count_one !== tool_count_two) throw new Error("Concurrent clients received inconsistent tool lists");

	for (const client of [client_one, client_two]) {
		const response = await fetch(`${base_url}/mcp`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${token}`, "Mcp-Session-Id": client.session_id },
		});
		if (response.status !== 204) throw new Error(`Session delete returned ${response.status}`);
	}

	const health = await fetch(`${base_url}/health`);
	const health_result: any = await health.json();
	if (health_result.sessions !== 0) throw new Error(`Expected zero sessions, received ${health_result.sessions}`);

	console.log(JSON.stringify({ success: true, clients: 2, tools: tool_count_one, authentication: true, origin_validation: true, clean_sessions: true }, null, 2));
} finally {
	child.kill("SIGTERM");
	const exit_code = await child.exited;
	const stdout = await stdout_promise;
	const stderr = await stderr_promise;
	if (exit_code !== 0 && exit_code !== 143) throw new Error(`MCP HTTP server exited with ${exit_code}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
}
