#!/usr/bin/env bun

Bun.env.MCP_TRANSPORT = "http";

const original_log = console.log;
const original_error = console.error;

function redact_connection_credentials(value: unknown): unknown {
	if (typeof value !== "string") return value;
	return value.replace(/([a-z][a-z0-9+.-]*:\/\/[^:\s/]+):[^@\s/]+@/gi, "$1:***@");
}

console.log = (...values: unknown[]) => original_log(...values.map(redact_connection_credentials));
console.error = (...values: unknown[]) => original_error(...values.map(redact_connection_credentials));

try {
	await import("./http_server");
} finally {
	console.log = original_log;
	console.error = original_error;
}
