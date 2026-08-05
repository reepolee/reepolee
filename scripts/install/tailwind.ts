import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { get_verbose } from "./reporter";

type InstallOpts = { version: "latest" | string; get_task: string; };

const HOME = os.homedir();
const PLATFORM = os.platform();

const BIN_DIR = path.join(HOME, "bin");

// Progress chatter is debug detail; the reporter shows one summary line instead.
function log(msg: string) { if (get_verbose()) { console.log(`[tailwindcss] ${msg}`); } }

function ensure_dir(dir: string) { fs.mkdirSync(dir, { recursive: true }); }

async function fetch_release(version: string) {
	const url = version === "latest" ? "https://api.github.com/repos/tailwindlabs/tailwindcss/releases/latest" : `https://api.github.com/repos/tailwindlabs/tailwindcss/releases/tags/v${version}`;

	const res = await fetch(url, {
		headers: { "User-Agent": "reepolee-installer", Accept: "application/vnd.github+json" },
	});

	if (!res.ok) { throw new Error(`GitHub API error: ${res.status}`); }

	return (await res.json()) as { tag_name: string; assets: any[]; };
}

/* ---------------- ASSET SELECTION ---------------- */

// Release assets are single standalone executables named
// tailwindcss-<platform>-<arch>[.exe] - no archives to extract.
function asset_name(): string {
	const arch = process.arch === "arm64" ? "arm64" : "x64";

	switch (PLATFORM) {
		case "win32":
			return `tailwindcss-windows-${arch}.exe`;
		case "darwin":
			return `tailwindcss-macos-${arch}`;
		case "linux":
			return `tailwindcss-linux-${arch}`;
		default:
			throw new Error(`Unsupported platform: ${PLATFORM}`);
	}
}

function pick_asset(assets: any[], name: string): string {
	const match = assets.find((a) => a.name === name);
	if (!match) { throw new Error(`No release asset named ${name}`); }
	return match.browser_download_url;
}

/* ---------------- DOWNLOAD ---------------- */

async function download(url: string, out_path: string) {
	log(`Downloading: ${url}`);

	const res = await fetch(url);
	if (!res.ok) throw new Error(`Download failed: ${res.status}`);

	const buf = Buffer.from(await res.arrayBuffer());
	fs.writeFileSync(out_path, buf);

	if (PLATFORM !== "win32") { fs.chmodSync(out_path, 0o755); }

	log(`Saved: ${out_path}`);
}

/* ---------------- PATH SETUP ---------------- */

function add_to_user_path(dir: string) {
	if (PLATFORM === "win32") {
		const { execSync } = require("node:child_process");

		const path_result = execSync(`powershell -Command "[Environment]::GetEnvironmentVariable('Path','User')"`, { stdio: ["ignore", "pipe", "ignore"] });
		const user_path = path_result.toString().trim();

		if (!user_path.includes(dir)) {
			execSync(`powershell -Command "[Environment]::SetEnvironmentVariable('Path', $env:Path + ';${dir}', 'User')"`, { stdio: ["ignore", "pipe", "ignore"] });

			log(`Added to USER PATH: ${dir}`);
		} else {
			log("PATH already contains bin dir");
		}
	} else {
		const shell = fs.existsSync(path.join(HOME, ".zshrc")) ? path.join(HOME, ".zshrc") : path.join(HOME, ".bashrc");

		const line = `export PATH="$PATH:${dir}"`;

		const content = fs.existsSync(shell) ? fs.readFileSync(shell, "utf8") : "";

		if (!content.includes(line)) {
			fs.appendFileSync(shell, `\n# tailwindcss installer\n${line}\n`);
			log(`Added PATH to ${shell}`);
		} else {
			log("PATH already configured");
		}
	}
}

/* ---------------- INSTALL ---------------- */

// Installed as "tw" (not "tailwindcss") so it can never collide with a
// stray global npm shim (e.g. a leftover `bun add -g @tailwindcss/cli`) -
// that exact collision silently ran the npm shim instead of this standalone
// binary and broke `@import "tailwindcss"` resolution.
function bin_path() { return path.join(BIN_DIR, PLATFORM === "win32" ? "tw.exe" : "tw"); }

async function get_installed_version(): Promise<string | null> {
	const { execSync } = require("node:child_process");
	try {
		const output = execSync(`"${bin_path()}" --help`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		const match = output.match(/tailwindcss v(\d+\.\d+\.\d+)/i);
		return match ? match[1] : null;
	} catch {
		return null;
	}
}

export async function install_tailwind(opts: InstallOpts): Promise<string> {
	log(`Platform: ${PLATFORM}`);
	log(`Version: ${opts.version}`);

	ensure_dir(BIN_DIR);

	const release = await fetch_release(opts.version);
	const resolved_version = release.tag_name.replace(/^v/, "");

	if (fs.existsSync(bin_path())) {
		const installed_version = await get_installed_version();
		if (installed_version === resolved_version) {
			log(`tailwindcss ${installed_version} already installed`);
			add_to_user_path(BIN_DIR);
			return `${installed_version} already installed`;
		}
		log(`Installed version ${installed_version ?? "unknown"} differs from requested ${resolved_version}, upgrading...`);
	}

	const name = asset_name();
	const url = pick_asset(release.assets, name);
	log(`Resolved download URL:`);
	log(url);

	await download(url, bin_path());
	add_to_user_path(BIN_DIR);

	log(`Installed to ${bin_path()}`);
	log("Restart terminal to apply PATH changes");
	return `${resolved_version} (restart terminal for PATH)`;
}
