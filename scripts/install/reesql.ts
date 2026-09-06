import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { child_stdio, get_verbose } from "./reporter";

const PLATFORM = os.platform();

function run(cmd: string, args: string[], opts?: { shell?: boolean; }): Promise<void> {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd, args, { stdio: child_stdio(), ...opts });
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
		p.stdout!.on("data", (d: Buffer) => out += d.toString());
		p.stderr!.on("data", (d: Buffer) => out += d.toString());
		p.on("error", reject);
		p.on("exit", (code) => {
			if (code === 0) resolve(out.trim()); else reject(new Error(
				`${cmd} failed with ${code}`,
			));
		});
	});
}

async function get_installed_version(): Promise<string | null> {
	const commands = ["reesql"];
	const user_home = os.homedir();
	const user_bin_path = PLATFORM === "win32" ? join(user_home, "bin", "reesql.exe") : join(user_home, ".local", "bin", "reesql");
	if (existsSync(user_bin_path)) commands.push(user_bin_path);

	for (const command of commands) {
		try {
			const raw = await run_capture(command, ["--version"]);
			const match = raw.match(/(\d+\.\d+\.\d+)/);
			if (match) return match[1]!;
		} catch {
			// Try the explicit user-bin path when PATH lookup is stale.
		}
	}

	return null;
}

async function get_latest_version(): Promise<string> {
	const api_url = "https://api.github.com/repos/reepolee/reesql/releases/latest";
	if (PLATFORM === "win32") {
		const raw = await run_capture("powershell", [
			"-Command",
			`(Invoke-RestMethod '${api_url}').tag_name`,
		]);
		return raw.replace(/^v/, "").trim();
	}
	const raw = await run_capture("bash", [
		"-c",
		`curl -s ${api_url} | grep -o '"tag_name": *"[^"]*"' | head -1 | cut -d'"' -f4`,
	]);
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

export async function install_reesql(): Promise<string> {
	if (get_verbose()) { console.log(`[reesql] Platform: ${PLATFORM}`); }

	const [installed, latest] = await Promise.all([get_installed_version(), get_latest_version()]);

	if (get_verbose()) { console.log(`[reesql] Installed: ${installed ?? "none"}, Latest: ${latest}`); }

	if (installed === latest) { return "already installed"; }

	if (PLATFORM === "win32") {
		await install_windows();
	} else {
		await install_unix();
	}

	return installed ? "updated" : "added";
}
