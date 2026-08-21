// scripts/dev_run.ts - Unified dev orchestrator.
//
// Flags control which processes to run:
//   --app      main app server (bun --hot apps/main/server.ts --dev) + tailwind watcher
//   --reeman   reeman server  (bun --no-clear-screen apps/reeman/server.ts --dev)
//   --reeqa    reeqa server   (bun --no-clear-screen apps/reeqa/server.ts --dev)
//   --worker   queue worker   (bun --hot worker.ts)
//   --agent    run servers in agent mode (localhost only, no dev UI)
//   --other-ips log each server's other network interface addresses on startup
//
// No flags defaults to --app (backward compat with old `bun dev`).
//
// bun scripts:
//   dev         = --app
//   dev:worker  = --app --worker
//   dev:all     = --app --reeman --reeqa
//   dev:reeman  = --reeman
//   dev:reeqa   = --reeqa
//   dev:all:agent = --app --reeman --agent
//
// .env and config/ changes trigger a restart of the --app child only.

import { watch } from "node:fs";
import { join } from "node:path";

import { APPS_DIR } from "$config/paths";

const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const BLUE = "\x1b[34m";
const MAGENTA = "\x1b[35m";
const RESET = "\x1b[0m";

const run_app_flag = Bun.argv.includes("--app");
const run_reeman = Bun.argv.includes("--reeman");
const run_reeqa = Bun.argv.includes("--reeqa");
const run_worker_flag = Bun.argv.includes("--worker");
const is_agent_mode = Bun.argv.includes("--agent");
const other_ips_flag = Bun.argv.includes("--other-ips");

// Default: --app when no flags given (backward compat)
const no_flags = !run_app_flag && !run_reeman && !run_reeqa && !run_worker_flag;
const should_run_app = run_app_flag || no_flags;

// The worker is opt-in: it runs only when --worker is passed, never implicitly
// alongside --app.
const run_worker = run_worker_flag;

async function pipe_prefixed(stream: ReadableStream<Uint8Array>, label: string, color: string, out: NodeJS.WriteStream) {
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of stream) {
		buffer += decoder.decode(chunk, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			out.write(`${color}[${label}]${RESET} ${line}\n`);
		}
	}
	if (buffer.trim() !== "") {
		out.write(`${color}[${label}]${RESET} ${buffer}\n`);
	} else if (buffer.length > 0) {
		out.write(buffer);
	}
}

// CSS must be built once before the server starts serving static/app-dev.css.
const css_build = Bun.spawnSync(["bun", "run", "css:once"], { stdout: "inherit", stderr: "inherit" });
if (css_build.exitCode !== 0) {
	console.error("✗ Initial CSS build failed");
	process.exit(css_build.exitCode ?? 1);
}

function spawn_tw(): Bun.Subprocess<"ignore", "pipe", "pipe"> {
	return Bun.spawn(["bun", "run", "css:watch"], { stdout: "pipe", stderr: "pipe" });
}

function spawn_app(): Bun.Subprocess<"ignore", "pipe", "pipe"> {
	const args = ["bun", "--hot", "--no-clear-screen", join(APPS_DIR, "main", "server.ts"), "--dev"];
	if (is_agent_mode) args.push("--agent");
	if (other_ips_flag) args.push("--other-ips");
	return Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
}

function spawn_reeman(): Bun.Subprocess<"ignore", "pipe", "pipe"> {
	const args = ["bun", "--no-clear-screen", join(APPS_DIR, "reeman", "server.ts"), "--dev"];
	if (is_agent_mode) args.push("--agent");
	if (other_ips_flag) args.push("--other-ips");
	return Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
}

function spawn_reeqa(): Bun.Subprocess<"ignore", "pipe", "pipe"> {
	const args = ["bun", "--no-clear-screen", join(APPS_DIR, "reeqa", "server.ts"), "--dev"];
	if (other_ips_flag) args.push("--other-ips");
	return Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
}

function spawn_worker(): Bun.Subprocess<"ignore", "pipe", "pipe"> {
	return Bun.spawn(["bun", "--hot", "worker.ts"], { stdout: "pipe", stderr: "pipe" });
}

function attach(child: Bun.Subprocess<"ignore", "pipe", "pipe">, label: string, color: string) {
	pipe_prefixed(child.stdout, label, color, process.stdout);
	pipe_prefixed(child.stderr, label, color, process.stderr);
}

// ---- Start children ----
// NOTE: no `cwd` option on any spawn below - passing `cwd` to Bun.spawn breaks
// executable resolution on Windows (uv_spawn ENOENT even for an absolute exe
// path). Children inherit the project root working directory without it.

const tw = should_run_app ? spawn_tw() : null;
let app = should_run_app ? spawn_app() : null;
const reeman = run_reeman ? spawn_reeman() : null;
const reeqa = run_reeqa ? spawn_reeqa() : null;
const wk = run_worker ? spawn_worker() : null;

if (tw) attach(tw, "tw", YELLOW);
if (app) attach(app, "dev", CYAN);
if (reeman) attach(reeman, "reeman", BLUE);
if (reeqa) attach(reeqa, "reeqa", MAGENTA);
if (wk) attach(wk, "wk", GREEN);

// ---- Exit handling ----

let shutting_down = false;
let restart_timeout: Timer | null = null;
let env_watcher: ReturnType<typeof watch> | null = null;

function shutdown() {
	shutting_down = true;
	if (restart_timeout) clearTimeout(restart_timeout);
	env_watcher?.close();
	tw?.kill();
	app?.kill();
	reeman?.kill();
	reeqa?.kill();
	wk?.kill();
}

process.on("SIGINT", () => { shutdown(); process.exit(0); });
process.on("SIGTERM", () => { shutdown(); process.exit(0); });

// Non-app children run for the whole session.
tw?.exited.then((code) => { if (!shutting_down) console.error(`${YELLOW}[tw]${RESET} process exited with code ${code}`); });
reeman?.exited.then((code) => { if (!shutting_down) console.error(`${BLUE}[reeman]${RESET} process exited with code ${code}`); });
reeqa?.exited.then((code) => { if (!shutting_down) console.error(`${MAGENTA}[reeqa]${RESET} process exited with code ${code}`); });
wk?.exited.then((code) => { if (!shutting_down) console.error(`${GREEN}[wk]${RESET} process exited with code ${code}`); });

// ---- App restart watcher (.env / config/) ----

let restarting = false;

function debounced_restart(reason: string): void {
	if (restart_timeout) clearTimeout(restart_timeout);
	restart_timeout = setTimeout(() => {
		restart_timeout = null;
		restarting = true;
		console.log(`${MAGENTA}[env]${RESET} 🔁 Restarting dev server (${reason})`);
		app?.kill();
	}, 100);
}

if (should_run_app) {
	const env_config_watch_targets = [".env", "config"];
	env_watcher = watch(process.cwd(), { recursive: true }, (_event, filename) => {
		if (!filename) return;
		const posix_path = filename.replaceAll("\\", "/");
		const is_watched = env_config_watch_targets.some((target) => posix_path === target || posix_path.startsWith(`${target}/`));
		if (!is_watched) return;
		debounced_restart(`${_event}: ${filename}`);
	});
}

// ---- Main loop: restart --app on .env/config changes ----

if (app) {
	for (;;) {
		const exit_code = await app.exited;
		if (shutting_down) { process.exit(exit_code); }
		if (!restarting) {
			console.error(`${CYAN}[dev]${RESET} process exited with code ${exit_code}`);
			shutdown();
			process.exit(exit_code);
		}
		restarting = false;
		app = spawn_app();
		attach(app, "dev", CYAN);
	}
} else {
	// No --app: wait for other children to exit, then done.
	await Promise.all([reeman?.exited, reeqa?.exited, wk?.exited].filter(Boolean));
}
