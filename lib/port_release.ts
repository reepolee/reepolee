/**
 * lib/port_release.ts
 *
 * Frees the dev server port before Bun.serve() binds it.
 *
 * Windows: `netstat -ano` is parsed for LISTENING sockets on the port and each
 * owning process is killed with `taskkill /T /F` (tree kill, so a surviving
 * bun --watch or conc parent cannot respawn the listener). macOS/Linux: lsof
 * for discovery, kill -9 per pid.
 *
 * After killing, the port is polled until the listener is actually gone.
 * TerminateProcess/kill return before the kernel releases the socket, and on
 * Windows SO_REUSEADDR lets a second bind silently succeed while the zombie
 * keeps stealing connections - so "kill succeeded" alone proves nothing.
 * If the port is still held after the timeout, we fail loudly and exit.
 */

const verify_timeout_ms = 5000;
const verify_interval_ms = 200;

export function parse_netstat_listeners(output: string, port: number): number[] {
	const pids = new Set<number>();
	for (const line of output.split("\n")) {
		if (!line.includes("LISTENING")) continue;
		const trimmed = line.trim();
		const columns = trimmed.split(/\s+/);
		// Expected: TCP    0.0.0.0:3100    0.0.0.0:0    LISTENING    41320
		if (columns.length < 5) continue;
		const local_address = columns[1];
		if (!local_address.endsWith(`:${port}`)) continue;
		const pid = Number(columns[4]);
		if (Number.isInteger(pid) && pid > 0) pids.add(pid);
	}
	return [...pids];
}

export function parse_pid_lines(output: string): number[] {
	const pids = new Set<number>();
	for (const line of output.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const pid = Number(trimmed);
		if (Number.isInteger(pid) && pid > 0) pids.add(pid);
	}
	return [...pids];
}

async function run_capture(cmd: string[]): Promise<string> {
	const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
	const stdout_response = new Response(proc.stdout);
	const [output] = await Promise.all([stdout_response.text(), proc.exited]);
	return output;
}

async function find_listeners(port: number): Promise<number[]> {
	if (process.platform === "win32") {
		const output = await run_capture(["netstat", "-ano"]);
		return parse_netstat_listeners(output, port);
	}
	// lsof exits non-zero when nothing matches; run_capture only reads stdout.
	const output = await run_capture(["lsof", "-ti", `tcp:${port}`, "-sTCP:LISTEN"]);
	return parse_pid_lines(output);
}

async function kill_pid(pid: number): Promise<void> {
	const is_win = process.platform === "win32";
	const cmd = is_win ? ["taskkill", "/F", "/T", "/PID", String(pid)] : ["kill", "-9", String(pid)];
	const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	await proc.exited;
}

export async function kill_port(port: number): Promise<void> {
	// Never kill our own process tree: under bun --watch a restart can re-enter
	// this path while the previous incarnation still shows up on the port.
	const own_pids = new Set([process.pid, process.ppid]);

	const initial_pids = await find_listeners(port);
	const target_pids = initial_pids.filter((pid) => !own_pids.has(pid));
	if (target_pids.length === 0) return;

	console.log(`🔌 Port ${port} held by PID(s) ${target_pids.join(", ")} - killing...`);
	await Promise.all(target_pids.map((pid) => kill_pid(pid)));

	const deadline = Date.now() + verify_timeout_ms;
	while (Date.now() < deadline) {
		const current_pids = await find_listeners(port);
		const remaining_pids = current_pids.filter((pid) => !own_pids.has(pid));
		if (remaining_pids.length === 0) return;
		await Bun.sleep(verify_interval_ms);
	}

	const holder_pids = await find_listeners(port);
	console.error(`✗ Port ${port} is still held by PID(s) ${holder_pids.join(", ")} after ${verify_timeout_ms / 1000}s. Close that process and retry.`);
	process.exit(1);
}
