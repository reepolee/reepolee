#!/usr/bin/env bun

/**
 * scripts/smoke-integration.ts
 *
 * Integration smoke test: boots the server in test mode, curls a set of
 * endpoints, and reports pass/fail. Exits with code 1 if any check fails.
 *
 * Usage:
 * bun scripts/smoke-integration.ts                   # default (port 2600)
 * TEST_PORT=3333 bun scripts/smoke-integration.ts    # custom port
 * bun scripts/smoke-integration.ts --agent            # enable agent mode (tests protected routes)
 *
 * This script is also available via:
 * bun run smoke:integration
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TEST_PORT = Number(Bun.env.TEST_PORT) || 2600;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const STARTUP_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 5_000;

const use_agent = Bun.argv.includes("--agent");
const agent_username = Bun.env.AGENT_USER_USERNAME;

// ---------------------------------------------------------------------------
// Check definitions
// ---------------------------------------------------------------------------

interface Check {
	method: string;
	path: string;
	expected_status: number;
	description: string;
	body_contains?: string;
}

const checks: Check[] = [
	{
		method: "GET",
		path: "/",
		expected_status: 200,
		description: "Home page",
		body_contains: "<html",
	},
	{ method: "GET", path: "/robots.txt", expected_status: 200, description: "Static file" },
	{ method: "GET", path: "/nonexistent", expected_status: 404, description: "404 page" },
	{
		method: "GET",
		path: "/examples/kitchen-sink",
		expected_status: 200,
		description: "Template-rendered page",
		body_contains: "<html",
	},
];

// In agent mode we can test authenticated routes via X-Agent-User-Username header
if (use_agent && agent_username) {
	checks.push({
		method: "GET",
		path: "/system/users",
		expected_status: 200,
		description: "CRUD route (agent mode)",
		body_contains: "<html",
	});
} else if (!use_agent) {
	// Without auth, this should still return a response that exercises routing + middleware
	checks.push({
		method: "GET",
		path: "/system/users",
		expected_status: 200,
		description: "CRUD route",
		body_contains: "<html",
	});
}

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

const RED = "\u001b[31m";
const GREEN = "\u001b[32m";
const _YELLOW = "\u001b[33m";
const CYAN = "\u001b[36m";
const BOLD = "\u001b[1m";
const RESET = "\u001b[0m";

function pass(msg: string) { console.log(`  ${GREEN}✓${RESET} ${msg}`); }

function fail(msg: string) { console.log(`  ${RED}✗${RESET} ${msg}`); }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fetch_with_timeout(url: string, init: RequestInit, ms: number): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), ms);
	return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const server_args = ["server.ts", "--prod", "--test"];
if (use_agent) { server_args.push("--agent"); }

console.log(`${BOLD}🧪 Server Integration Smoke Test${RESET}`);
console.log(`   Port:    ${TEST_PORT}`);
console.log(`   Mode:    ${use_agent ? "agent" : "normal"}`);
console.log(`   Server:  bun ${server_args.join(" ")}`);
console.log("");

// 1. Start the server
console.log(`${CYAN}■${RESET} Starting server...`);

const server_process = Bun.spawn(["bun", ...server_args], {
	env: { ...Bun.env },
	stdout: "pipe",
	stderr: "pipe",
});

let server_ready = false;
let startup_output = "";

// Read stdout until we see the ready message or hit the timeout
const decoder = new TextDecoder();

const timeout_promise = new Promise<void>((resolve) => setTimeout(resolve, STARTUP_TIMEOUT_MS));
const ready_promise = (async () => {
	for await (const chunk of server_process.stdout) {
		const text = decoder.decode(chunk, { stream: true });
		startup_output += text;
		process.stdout.write(text);
		if (startup_output.includes("Test server ready at")) {
			server_ready = true;
			return;
		}
	}
})();

await Promise.race([ready_promise, timeout_promise]);

if (!server_ready) {
	console.error(`\n${RED}✗ Server did not start within ${STARTUP_TIMEOUT_MS / 1000}s${RESET}`);
	server_process.kill("SIGTERM");
	process.exit(1);
}

console.log(`\n${GREEN}✓${RESET} Server is ready\n`);

// 2. Run checks
console.log(`${BOLD}Running ${checks.length} check(s)...${RESET}\n`);

const agent_headers: Record<string, string> = {};
if (use_agent && agent_username) { agent_headers["X-Agent-User-Username"] = agent_username; }

let passed = 0;
let failed = 0;

for (const check of checks) {
	const url = `${BASE_URL}${check.path}`;
	try {
		const response = await fetch_with_timeout(url, {
			method: check.method,
			headers: { ...agent_headers, ...(check.method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
		}, REQUEST_TIMEOUT_MS);

		const status_match = response.status === check.expected_status;
		let body_match = true;

		if (check.body_contains) {
			const body = await response.text();
			body_match = body.includes(check.body_contains);
		}

		if (status_match && body_match) {
			pass(`${check.description} - ${response.status}${check.body_contains ? " (body ok)" : ""}`);
			passed++;
		} else {
			const detail = [`${check.method} ${check.path}`];
			if (!status_match) detail.push(`expected ${check.expected_status}, got ${response.status}`);
			if (!body_match) detail.push(`body missing "${check.body_contains}"`);
			fail(`${check.description} - ${detail.join("; ")}`);
			failed++;
		}
	} catch (err: any) {
		fail(`${check.description} - ${check.method} ${check.path}: ${err?.message || String(err)}`);
		failed++;
	}
}

// 3. Cleanup
server_process.kill("SIGTERM");

// Brief wait for graceful shutdown
await Bun.sleep(500);

// Force kill if still alive
try {
	server_process.kill("SIGKILL");
} catch {
	// already dead
}

// 4. Report
console.log("");
console.log("═".repeat(50));
console.log(`${BOLD}Results:${RESET} ${GREEN}${passed} passed${RESET}${failed > 0 ? `, ${RED}${failed} failed${RESET}` : ""}`);
console.log("═".repeat(50));
console.log("");

process.exit(failed > 0 ? 1 : 0);
