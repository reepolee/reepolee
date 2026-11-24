import { mkdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

export type InstallArchiveOptions = {
	marketplace_root?: string;
	project_root?: string;
};

function validate_entry_path(entry_path: string): string[] {
	const normalized_path = entry_path.replaceAll("\\", "/");
	const path_segments = normalized_path.split("/");
	const clean_segments = path_segments.filter((segment) => segment.length > 0);
	const has_parent_segment = clean_segments.includes("..");
	while (clean_segments[0] === ".") clean_segments.shift();
	if (isAbsolute(entry_path) || has_parent_segment || clean_segments.length < 2) {
		throw new Error(`Archive entry must be inside one top-level folder: ${entry_path}`);
	}
	return clean_segments;
}

async function run_install_script(module_root: string, project_root: string): Promise<void> {
	const is_windows = process.platform === "win32";
	const script_name = is_windows ? "install.ps1" : "install.sh";
	const script_path = join(module_root, script_name);
	const script_file = Bun.file(script_path);
	if (!(await script_file.exists())) {
		throw new Error(`Archive is missing ${script_name} in its top-level folder.`);
	}

	const command = is_windows
		? ["pwsh", "-NoProfile", "-File", script_path]
		: ["bash", script_path];
	const install_process = Bun.spawn(command, {
		cwd: project_root,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
		windowsHide: true,
	});
	const exit_code = await install_process.exited;
	if (exit_code !== 0) {
		throw new Error(`${script_name} exited with code ${exit_code}.`);
	}
}

export async function install_marketplace_archive(archive_path: string, options: InstallArchiveOptions = {}): Promise<string> {
	const lowercase_archive_path = archive_path.toLowerCase();
	if (!lowercase_archive_path.endsWith(".tar.gz")) {
		throw new Error("Marketplace archives must use the .tar.gz extension.");
	}

	const archive_file = Bun.file(archive_path);
	if (!(await archive_file.exists())) {
		throw new Error(`Archive not found: ${archive_path}`);
	}

	const archive_bytes = await archive_file.bytes();
	const archive = new Bun.Archive(archive_bytes);
	const archive_files = await archive.files();
	if (archive_files.size === 0) {
		throw new Error("Archive contains no files.");
	}

	let top_level_folder = "";
	for (const entry_path of archive_files.keys()) {
		const path_segments = validate_entry_path(entry_path);
		const entry_top_level = path_segments[0] ?? "";
		if (!top_level_folder) top_level_folder = entry_top_level;
		if (entry_top_level !== top_level_folder) {
			throw new Error("Archive must contain exactly one top-level folder.");
		}
	}

	const project_root = options.project_root ?? process.cwd();
	const marketplace_root = options.marketplace_root ?? join(project_root, "marketplace");
	const module_root = join(marketplace_root, top_level_folder);
	const module_file = Bun.file(module_root);
	if (await module_file.exists()) {
		throw new Error(`Marketplace folder already exists: ${module_root}`);
	}

	await mkdir(marketplace_root, { recursive: true });
	try {
		const destination_folders = new Set<string>();
		for (const entry_path of archive_files.keys()) {
			const path_segments = validate_entry_path(entry_path);
			const destination_path = join(marketplace_root, ...path_segments);
			destination_folders.add(dirname(destination_path));
		}
		const mkdir_operations = Array.from(destination_folders, (folder) => mkdir(folder, { recursive: true }));
		await Promise.all(mkdir_operations);

		const write_operations: Promise<number>[] = [];
		for (const [entry_path, entry_file] of archive_files) {
			const path_segments = validate_entry_path(entry_path);
			const destination_path = join(marketplace_root, ...path_segments);
			write_operations.push(Bun.write(destination_path, entry_file));
		}
		await Promise.all(write_operations);
		await run_install_script(module_root, project_root);
		return module_root;
	} catch (error) {
		await rm(module_root, { recursive: true, force: true });
		throw error;
	}
}
