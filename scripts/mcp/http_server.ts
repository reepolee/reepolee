#!/usr/bin/env bun

import { env_available } from "$config/env_vars";
import { handle_mcp_message, shutdown_mcp_server } from "./index";

const HOSTNAME = "127.0.0.1";
const MCP_PATH = "/mcp";
const HEALTH_PATH = "/health";
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

type McpSession = {
	initialized: boolean;
	last_seen_at: number;
	protocol_version: string;
};

function read_http_port(): number {
	const raw_port = Bun.env.MCP_HTTP_PORT?.trim() || "2401";
	const port = Number(raw_port);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error(`MCP_HTTP_PORT must be an integer from 1 to 65535, received "${raw_port}"`);
	}
	return port;
}

function read_http_token(): string {
	if (!env_available("MCP_HTTP_TOKEN")) {
		throw new Error("MCP_HTTP_TOKEN is required for the Streamable HTTP server");
	}
	const token = Bun.env.MCP_HTTP_TOKEN!.trim();
	if (token.length < 32) throw new Error("MCP_HTTP_TOKEN must be at least 32 characters");
	return token;
}

function json_headers(extra_headers: Record<string, string> = {}): Headers {
	const headers = new Headers(extra_headers);
	headers.set("Content-Type", "application/json");
	headers.set("Cache-Control", "no-store");
	return headers;
}

function error_response(status: number, code: number, message: string, id: unknown = null): Response {
	const body = JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
	return new Response(body, { status, headers: json_headers() });
}

function origin_allowed(origin: string | null): boolean {
	if (!origin) return true;
	try {
		const parsed_origin = new URL(origin);
		const local_hostname = parsed_origin.hostname === "127.0.0.1" || parsed_origin.hostname === "localhost";
		return parsed_origin.protocol === "http:" && local_hostname;
	} catch {
		return false;
	}
}

function authorized(request: Request, token: string): boolean {
	const authorization = request.headers.get("Authorization");
	return authorization === `Bearer ${token}`;
}

function accepts_mcp_response(request: Request): boolean {
	const accept = request.headers.get("Accept");
	if (!accept) return false;
	return accept.includes("application/json") && accept.includes("text/event-stream");
}

function session_response(response: string, session_id?: string): Response {
	const extra_headers: Record<string, string> = {};
	if (session_id) extra_headers["Mcp-Session-Id"] = session_id;
	return new Response(response.trimEnd(), { status: 200, headers: json_headers(extra_headers) });
}

function request_content_too_large(request: Request): boolean {
	const raw_length = request.headers.get("Content-Length");
	if (!raw_length) return false;
	const content_length = Number(raw_length);
	return Number.isFinite(content_length) && content_length > MAX_BODY_BYTES;
}

async function read_message(request: Request): Promise<Record<string, any>> {
	if (request_content_too_large(request)) throw new Error("Request body exceeds 4 MiB");
	const body = await request.text();
	const body_bytes = new TextEncoder().encode(body).byteLength;
	if (body_bytes > MAX_BODY_BYTES) throw new Error("Request body exceeds 4 MiB");
	const message = JSON.parse(body);
	if (!message || typeof message !== "object" || Array.isArray(message)) {
		throw new Error("Request body must be one JSON-RPC message");
	}
	return message;
}

async function handle_post(request: Request, sessions: Map<string, McpSession>): Promise<Response> {
	if (!accepts_mcp_response(request)) {
		return error_response(406, -32600, "Accept must include application/json and text/event-stream");
	}
	const content_type = request.headers.get("Content-Type") || "";
	if (!content_type.toLowerCase().startsWith("application/json")) {
		return error_response(415, -32600, "Content-Type must be application/json");
	}

	let message: Record<string, any>;
	try {
		message = await read_message(request);
	} catch (error) {
		const message_text = error instanceof Error ? error.message : String(error);
		return error_response(400, -32700, message_text);
	}

	const message_id = message.id ?? null;
	const method = message.method;
	const supplied_session_id = request.headers.get("Mcp-Session-Id");
	if (method === "initialize") {
		if (supplied_session_id) return error_response(400, -32600, "Initialize must not include Mcp-Session-Id", message_id);
		const response = await handle_mcp_message(message);
		if (!response) return error_response(500, -32603, "Initialize did not produce a response", message_id);
		const parsed_response = JSON.parse(response);
		const protocol_version = parsed_response.result?.protocolVersion || "2025-11-25";
		const session_id = crypto.randomUUID();
		sessions.set(session_id, { initialized: false, last_seen_at: Date.now(), protocol_version });
		return session_response(response, session_id);
	}

	if (!supplied_session_id) return error_response(400, -32600, "Mcp-Session-Id is required", message_id);
	const session = sessions.get(supplied_session_id);
	if (!session) return error_response(404, -32001, "MCP session not found", message_id);
	session.last_seen_at = Date.now();

	const protocol_version = request.headers.get("MCP-Protocol-Version");
	if (protocol_version && protocol_version !== session.protocol_version) {
		return error_response(400, -32600, "MCP-Protocol-Version does not match the initialized session", message_id);
	}

	if (method === "notifications/initialized") session.initialized = true;
	if (method === "notifications/exit") {
		sessions.delete(supplied_session_id);
		return new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });
	}
	if (method !== "notifications/initialized" && !session.initialized) {
		return error_response(400, -32600, "MCP session has not completed initialization", message_id);
	}

	const response = await handle_mcp_message(message);
	if (!response) return new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });
	return session_response(response);
}

async function handle_request(request: Request, token: string, sessions: Map<string, McpSession>): Promise<Response> {
	const url = new URL(request.url);
	if (url.pathname === HEALTH_PATH && request.method === "GET") {
		return Response.json({ ok: true, transport: "streamable-http", sessions: sessions.size }, { headers: { "Cache-Control": "no-store" } });
	}
	if (url.pathname !== MCP_PATH) return new Response("Not Found", { status: 404 });
	if (!origin_allowed(request.headers.get("Origin"))) return error_response(403, -32000, "Origin is not allowed");
	if (!authorized(request, token)) {
		return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
	}

	if (request.method === "POST") return await handle_post(request, sessions);
	if (request.method === "DELETE") {
		const session_id = request.headers.get("Mcp-Session-Id");
		if (!session_id || !sessions.delete(session_id)) return error_response(404, -32001, "MCP session not found");
		return new Response(null, { status: 204 });
	}
	return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST, DELETE" } });
}

const port = read_http_port();
const token = read_http_token();
const sessions = new Map<string, McpSession>();
const session_cleanup_timer = setInterval(() => {
	const expiry = Date.now() - SESSION_TTL_MS;
	for (const [session_id, session] of sessions) {
		if (session.last_seen_at < expiry) sessions.delete(session_id);
	}
}, 5 * 60 * 1000);
const server = Bun.serve({
	hostname: HOSTNAME,
	port,
	fetch: (request) => handle_request(request, token, sessions),
});

console.log(`[ree-mcp] Streamable HTTP listening at http://${HOSTNAME}:${server.port}${MCP_PATH}`);
console.log(`[ree-mcp] Health check at http://${HOSTNAME}:${server.port}${HEALTH_PATH}`);

let stopping = false;
async function stop_http_server(): Promise<void> {
	if (stopping) return;
	stopping = true;
	clearInterval(session_cleanup_timer);
	server.stop(true);
	await shutdown_mcp_server();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		stop_http_server().then(() => process.exit(0), (error) => {
			console.error("[ree-mcp] HTTP shutdown failed:", error);
			process.exit(1);
		});
	});
}
