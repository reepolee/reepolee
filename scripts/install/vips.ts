import { spawn } from "node:child_process";
import { cpSync } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type InstallOpts = { version: "latest" | string; get_task: string; };

const HOME = os.homedir();
const PLATFORM = os.platform();

const BIN_DIR = path.join(HOME, "bin");
const INSTALL_DIR = path.join(BIN_DIR, "vips");
const CACHE_DIR = path.join(HOME, ".cache", "reepolee", "vips");

function log(msg: string) { console.log(`[vips] ${msg}`); }

function ensure_dir(dir: string) { fs.mkdirSync(dir, { recursive: true }); }

function run(cmd: string, args: string[]) {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd, args, { stdio: "inherit" });
		p.on("exit", (code) => { if (code === 0) resolve(); else reject(new Error(`${cmd} failed with ${code}`)); });
	});
}

async function fetch_release(version: string) {
	const url = version === "latest" ? "https://api.github.com/repos/libvips/build-win64-mxe/releases/latest" : `https://api.github.com/repos/libvips/build-win64-mxe/releases/tags/v${version}`;

	const res = await fetch(url, {
		headers: { "User-Agent": "reepolee-installer", Accept: "application/vnd.github+json" },
	});

	if (!res.ok) { throw new Error(`GitHub API error: ${res.status}`); }

	return res.json();
}

/* ---------------- ARCH DETECTION ---------------- */

function get_arch(): "x64" | "arm64" {
	switch (process.arch) {
		case "x64":
			return "x64";
		case "arm64":
			return "arm64";
		default:
			throw new Error(`Unsupported architecture: ${process.arch}`);
	}
}

/* Compare semantic versions. Returns: >0 if v1>v2, 0 if equal, <0 if v1<v2 */
function compare_versions(v1: string, v2: string): number {
	const p1 = v1.split(".").map(Number);
	const p2 = v2.split(".").map(Number);
	const len = Math.max(p1.length, p2.length);

	for (let i = 0; i < len; i++) {
		const n1 = p1[i] ?? 0;
		const n2 = p2[i] ?? 0;
		if (n1 > n2) return 1;
		if (n1 < n2) return -1;
	}
	return 0;
}

/* ---------------- WINDOWS ASSET SELECTION ---------------- */

function pick_windows_asset(assets: any[], arch: "x64" | "arm64") {
	const matches = assets.filter((a) => {
		const n = a.name.toLowerCase();

		return n.includes("vips") && n.includes(arch) && n.endsWith(".zip");
	});

	// Prefer "all" builds if available
	const preferred = matches.find((a) => a.name.toLowerCase().includes("all")) ?? matches[0];

	if (!preferred) { throw new Error(`No Windows build found for arch=${arch}`); }

	return preferred.browser_download_url;
}

/* ---------------- DOWNLOAD ---------------- */

async function download(url: string, outPath: string) {
	if (fs.existsSync(outPath)) {
		log("Using cached archive");
		return;
	}

	log(`Downloading: ${url}`);

	const res = await fetch(url);
	if (!res.ok) throw new Error(`Download failed: ${res.status}`);

	const buf = Buffer.from(await res.arrayBuffer());
	fs.writeFileSync(outPath, buf);

	log(`Saved: ${outPath}`);
}

/* ---------------- EXTRACT ---------------- */

async function extract(zip: string, outDir: string) {
	log("Extracting...");

	await run("powershell", ["-Command", `Expand-Archive -Force -Path "${zip}" -DestinationPath "${outDir}"`]);
}

/* ---------------- PATH SETUP ---------------- */

function add_to_user_path(dir: string) {
	if (PLATFORM === "win32") {
		const { execSync } = require("node:child_process");

		const user_path = execSync(`powershell -Command "[Environment]::GetEnvironmentVariable('Path','User')"`).toString().trim();

		if (!user_path.includes(dir)) {
			execSync(`powershell -Command "[Environment]::SetEnvironmentVariable('Path', $env:Path + ';${dir}', 'User')"`);

			log(`Added to USER PATH: ${dir}`);
		} else {
			log("PATH already contains bin dir");
		}
	} else {
		const shell = fs.existsSync(path.join(HOME, ".zshrc")) ? path.join(HOME, ".zshrc") : path.join(HOME, ".bashrc");

		const line = `export PATH="$PATH:${dir}"`;

		const content = fs.existsSync(shell) ? fs.readFileSync(shell, "utf8") : "";

		if (!content.includes(line)) {
			fs.appendFileSync(shell, `\n# vips installer\n${line}\n`);
			log(`Added PATH to ${shell}`);
		} else {
			log("PATH already configured");
		}
	}
}

/* ---------------- PLATFORM INSTALLERS ---------------- */

async function install_mac() {
	log("macOS detected → brew install vips");
	await run("brew", ["install", "vips"]);
}

async function install_linux() {
	log("Linux detected");

	try {
		await run("sudo", ["apt", "install", "-y", "libvips-dev"]);
		return;
	} catch {}

	try {
		await run("sudo", ["dnf", "install", "-y", "vips-devel"]);
		return;
	} catch {}

	await run("sudo", ["pacman", "-S", "--noconfirm", "vips"]);
}

/* ---------------- WINDOWS INSTALL ---------------- */

function vips_exe_path() { return path.join(BIN_DIR, "vips.exe"); }

function find_extracted_bin_dir(install_dir: string): string {
	const entries = fs.readdirSync(install_dir, { withFileTypes: true });

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		if (!entry.name.startsWith("vips-dev-")) continue;

		const bin_path = path.join(install_dir, entry.name, "bin");
		if (fs.existsSync(bin_path)) { return bin_path; }
	}

	throw new Error(`No vips-dev-*/bin found in ${install_dir}`);
}

async function get_installed_version(): Promise<string | null> {
	const { execSync } = require("node:child_process");
	try {
		const output = execSync("vips -v", { encoding: "utf8" });
		const match = output.match(/vips-(\d+\.\d+\.\d+)/);
		return match ? match[1] : null;
	} catch {
		return null;
	}
}

async function install_windows(version: string, get_task: string) {
	ensure_dir(BIN_DIR);
	ensure_dir(INSTALL_DIR);
	ensure_dir(CACHE_DIR);

	const arch = get_arch();
	log(`Detected architecture: ${arch}`);

	const release = await fetch_release(version);

	const resolved_version = release.tag_name.replace(/^v/, "");

	if (fs.existsSync(vips_exe_path())) {
		const installed_version = await get_installed_version();
		if (installed_version === resolved_version) {
			log(`vips ${installed_version} already installed`);
			add_to_user_path(BIN_DIR);
			return;
		}
		if (installed_version && compare_versions(installed_version, resolved_version) > 0) {
			log(`Installed version ${installed_version} is newer than requested ${resolved_version}`);
			log(`Run 'bun ${get_task}' to update this project's requested vips version`);
			add_to_user_path(BIN_DIR);
			return;
		}
		log(`Installed version ${installed_version} differs from requested ${resolved_version}, upgrading...`);
	}

	const zip_path = path.join(CACHE_DIR, `vips-${resolved_version}-${arch}.zip`);

	const url = pick_windows_asset(release.assets, arch);
	log(`Resolved download URL:`);
	log(url);

	await download(url, zip_path);

	let src_bin: string | null = null;
	try {
		src_bin = find_extracted_bin_dir(INSTALL_DIR);
	} catch {}

	if (!src_bin) {
		await extract(zip_path, INSTALL_DIR);
		src_bin = find_extracted_bin_dir(INSTALL_DIR);
	}

	cpSync(src_bin, BIN_DIR, { recursive: true });

	add_to_user_path(BIN_DIR);

	log(`Installed to ${BIN_DIR}`);
	log("Restart terminal to apply PATH changes");
}

/* ---------------- MAIN ---------------- */

export async function install_vips(opts: InstallOpts) {
	log(`Platform: ${PLATFORM}`);
	log(`Version: ${opts.version}`);

	if (PLATFORM === "darwin") return install_mac();
	if (PLATFORM === "linux") return install_linux();
	if (PLATFORM === "win32") return install_windows(opts.version, opts.get_task);

	throw new Error(`Unsupported platform: ${PLATFORM}`);
}
