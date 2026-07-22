import { spawn } from "node:child_process";
import os from "node:os";

const PLATFORM = os.platform();

function run(cmd: string, args: string[], opts?: { shell?: boolean; }): Promise<void> {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd, args, { stdio: "inherit", ...opts });
		p.on("exit", (code) => { if (code === 0) resolve(); else reject(new Error(`${cmd} failed with ${code}`)); });
	});
}

function run_capture(cmd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		let p: ReturnType<typeof spawn>;
		try {
			p = spawn(cmd, args, { stdio: "pipe" });
		} catch (e) {
			return reject(e);
		}
		let out = "";
		p.stdout.on("data", (d: Buffer) => out += d.toString());
		p.stderr.on("data", (d: Buffer) => out += d.toString());
		p.on("error", reject);
		p.on("exit", (code) => { if (code === 0) resolve(out.trim()); else reject(new Error(`${cmd} failed with ${code}`)); });
	});
}

async function get_installed_version(): Promise<string | null> {
	try {
		const raw = await run_capture("reesql", ["--version"]);
		const match = raw.match(/(\d+\.\d+\.\d+)/);
		return match ? match[1] : null;
	} catch {
		return null;
	}
}

async function get_latest_version(): Promise<string> {
	const api_url = "https://api.github.com/repos/reepolee/reesql/releases/latest";
	if (PLATFORM === "win32") {
		const raw = await run_capture("powershell", ["-Command", `(Invoke-RestMethod ${api_url}).tag_name`]);
		return raw.replace(/^v/, "").trim();
	}
	const raw = await run_capture("bash", ["-c", `curl -s ${api_url} | grep -o '"tag_name": *"[^"]*"' | head -1 | cut -d'"' -f4`]);
	return raw.replace(/^v/, "").trim();
}

async function install_unix() {
	const url = "https://raw.githubusercontent.com/reepolee/reesql/main/install.sh";
	await run("bash", ["-c", `curl -fsSL ${url} | bash`]);
}

async function install_windows() {
	const url = "https://raw.githubusercontent.com/reepolee/reesql/main/install.ps1";
	await run("powershell", ["-Command", `irm ${url} | iex`]);
}

export async function install_reesql() {
	console.log(`[reesql] Platform: ${PLATFORM}`);

	const installed = await get_installed_version();
	const latest = await get_latest_version();

	console.log(`[reesql] Installed: ${installed ?? "none"}, Latest: ${latest}`);

	if (installed === latest) {
		console.log("[reesql] Already up to date, skipping install.");
		return;
	}

	if (PLATFORM === "win32") {
		await install_windows();
	} else {
		await install_unix();
	}

	console.log("[reesql] Installed successfully");
}
