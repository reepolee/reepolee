// scripts/dev_run.ts - Dev orchestrator: server + Tailwind watcher (+ worker on demand).
//
// Builds CSS once, then runs `tailwindcss --watch=always` (its own incremental
// engine) alongside `bun --hot server.ts --dev`. `--watch=always` is required:
// without it, `--watch` exits as soon as it detects its stdin has closed,
// which Bun.spawn's non-interactive stdin triggers almost immediately - the
// process looks alive but silently stops rebuilding.
//
// Known tradeoff: tailwindcss's watcher can only subscribe to whole
// directories, so it also watches its own output directory (static/) and
// re-triggers itself on every write to app-dev.css - confirmed via an
// isolated run producing 6 rebuilds over 8s with zero source edits. Each of
// those extra rebuilds is ms-level and cheap, though. The alternative (a
// one-shot `bun css:once` per change, triggered by our own fs watcher instead
// of tailwindcss's) avoids the self-triggering but costs a ~1s CLI cold start
// per real save - worse in practice, so the frequent-but-cheap rebuilds here
// are the intentional choice.
//
// Also starts the queue worker (`bun --hot worker.ts`) when either:
//   - `--worker` is passed, or
//   - `REDIS_URL` is set in the environment (worker.ts is a no-op without it).
//
// .env and config/ are read once at server.ts process start (Bun.env / static
// imports), so bun --hot's module re-evaluation can't pick up changes to them
// the way it does for the rest of the app. This orchestrator watches both and
// kills + respawns just the `[dev]` child when either changes (ported from
// ree-web's scripts/dev/orchestrate.ts, which solves the same problem there).
//
// Usage:
//   bun scripts/dev_run.ts            # server only (matches old `bun dev`)
//   bun scripts/dev_run.ts --worker   # server + worker (matches old `bun devw`)

import { watch } from "node:fs";

const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const MAGENTA = "\x1b[35m";
const RESET = "\x1b[0m";

// NOTE: no `cwd` option on any spawn below - passing `cwd` to Bun.spawn breaks
// executable resolution on Windows (uv_spawn ENOENT even for an absolute exe
// path). `bun run dev`/`devw` already run from the project root, so the
// children inherit the right working directory without it.
const run_worker = Bun.argv.includes("--worker") || !!Bun.env.REDIS_URL;

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
	// Remaining buffer
	if (buffer.trim() !== "") {
		out.write(`${color}[${label}]${RESET} ${buffer}\n`);
	} else if (buffer.length > 0) {
		out.write(buffer);
	}
}

// CSS must be built once before the server starts serving static/app-dev.css,
// and before tailwindcss --watch takes over (--watch also does an initial
// build, but the server would otherwise race it for the very first request).
const css_build = Bun.spawnSync(["bun", "run", "css:once"], { stdout: "inherit", stderr: "inherit" });
if (css_build.exitCode !== 0) {
	console.error("✗ Initial CSS build failed");
	process.exit(css_build.exitCode ?? 1);
}

function spawn_tw(): Bun.Subprocess<"ignore", "pipe", "pipe"> {
	return Bun.spawn(["bun", "run", "css:watch"], { stdout: "pipe", stderr: "pipe" });
}

function spawn_dev(): Bun.Subprocess<"ignore", "pipe", "pipe"> {
	return Bun.spawn(["bun", "--hot", "--no-clear-screen", "server.ts", "--dev"], { stdout: "pipe", stderr: "pipe" });
}

function spawn_worker(): Bun.Subprocess<"ignore", "pipe", "pipe"> {
	return Bun.spawn(["bun", "--hot", "worker.ts"], { stdout: "pipe", stderr: "pipe" });
}

const tw = spawn_tw();
let dev = spawn_dev();
const wk = run_worker ? spawn_worker() : null;

function attach(child: Bun.Subprocess<"ignore", "pipe", "pipe">, label: string, color: string) {
	pipe_prefixed(child.stdout, label, color, process.stdout);
	pipe_prefixed(child.stderr, label, color, process.stderr);
}

attach(tw, "tw", YELLOW);
attach(dev, "dev", CYAN);
if (wk) { attach(wk, "wk", GREEN); }

// dev is respawned on .env/config changes (see below), so its exit handling
// is wired separately from the other two, which run for the whole session.
tw.exited.then((code) => { console.error(`${YELLOW}[tw]${RESET} process exited with code ${code}`); });
if (wk) { wk.exited.then((code) => { console.error(`${GREEN}[wk]${RESET} process exited with code ${code}`); }); }

let shutting_down = false;
let restarting = false;
let restart_timeout: Timer | null = null;

function debounced_restart(reason: string): void {
	if (restart_timeout) clearTimeout(restart_timeout);
	restart_timeout = setTimeout(() => {
		restart_timeout = null;
		restarting = true;
		console.log(`${MAGENTA}[env]${RESET} 🔁 Restarting dev server (${reason})`);
		dev.kill();
	}, 100);
}

const project_root = process.cwd();
const env_config_watch_targets = [".env", "config"];

const env_watcher = watch(project_root, { recursive: true }, (event, filename) => {
	if (!filename) return;
	const posix_path = filename.replaceAll("\\", "/");
	const is_watched = env_config_watch_targets.some((target) => posix_path === target || posix_path.startsWith(`${target}/`));
	if (!is_watched) return;
	debounced_restart(`${event}: ${filename}`);
});

function shutdown() {
	shutting_down = true;
	if (restart_timeout) clearTimeout(restart_timeout);
	env_watcher.close();
	tw.kill();
	dev.kill();
	if (wk) { wk.kill(); }
}

process.on("SIGINT", () => { shutdown(); process.exit(0); });
process.on("SIGTERM", () => { shutdown(); process.exit(0); });

for (;;) {
	const exit_code = await dev.exited;
	if (shutting_down) { process.exit(exit_code); }
	if (!restarting) {
		console.error(`${CYAN}[dev]${RESET} process exited with code ${exit_code}`);
		shutdown();
		process.exit(exit_code);
	}
	restarting = false;
	dev = spawn_dev();
	attach(dev, "dev", CYAN);
}
