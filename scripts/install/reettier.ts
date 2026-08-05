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
		try { p = spawn(
			cmd,
			args,
			{ stdio: "pipe" }
		);
		} catch (e) {
			return reject(e);
		};

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

export function normalize_reettier_version(version: string): string {
	const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
	if (!match) return version.trim();
	return `${match[1]}.${match[2]!.padStart(2, "0")}.${match[3]}`;
}

async function get_installed_version(): Promise<string | null> {
	const commands = ["reettier"];
	const user_bin_path = process.env.USERPROFILE ? join(process.env.USERPROFILE, "bin", "reettier.exe") : "";
	if (PLATFORM === "win32" && user_bin_path && existsSync(user_bin_path)) commands.push(user_bin_path);

	for (const command of commands) {
		try {
			const raw = await run_capture(command, ["--version"]);
			const match = raw.match(/(\d+\.\d+\.\d+)/);
			const version = match?.[1];
			if (version) return normalize_reettier_version(version);
		} catch {
			// Try the explicit Windows user-bin path when PATH lookup is stale.
		}
	}

	return null;
}

async function get_latest_version(): Promise<string> {
	const api_url = "https://api.github.com/repos/reepolee/reettier/releases/latest";
	if (PLATFORM === "win32") {
		const raw = await run_capture("powershell", [
			"-Command",
			`(Invoke-RestMethod '${api_url}').tag_name`,
		]);
		return normalize_reettier_version(raw.replace(/^v/, "").trim());
	}
	const raw = await run_capture("bash", [
		"-c",
		`curl -s ${api_url} | grep -o '"tag_name": *"[^"]*"' | head -1 | cut -d'"' -f4`,
	]);
	return normalize_reettier_version(raw.replace(/^v/, "").trim());
}

async function install_unix() {
	const url = "https://raw.githubusercontent.com/reepolee/reettier/main/install.sh";
	await run("bash", ["-c", `curl -fsSL ${url} | bash`]);
}

async function install_windows() {
	const url = "https://raw.githubusercontent.com/reepolee/reettier/main/install.ps1";
	await run("powershell", ["-Command", `irm ${url} | iex`]);
}

export async function install_reettier(): Promise<string> {
	if (get_verbose()) { console.log(`[reettier] Platform: ${PLATFORM}`); }

	const [installed, latest] = await Promise.all([get_installed_version(), get_latest_version()]);

	if (get_verbose()) { console.log(`[reettier] Installed: ${installed ?? "none"}, Latest: ${latest}`); }

	if (installed === latest) { return `${installed} already up to date`; }

	if (PLATFORM === "win32") {
		await install_windows();
	} else {
		await install_unix();
	}

	return latest;
}
