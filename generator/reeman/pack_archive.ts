import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export type PackArchiveOptions = {
	marketplace_root?: string;
};

async function directory_exists(path: string): Promise<boolean> {
	try {
		const stats = await stat(path);
		return stats.isDirectory();
	} catch {
		return false;
	}
}

export async function pack_marketplace_folder(folder_name: string, options: PackArchiveOptions = {}): Promise<string> {
	if (!folder_name || isAbsolute(folder_name) || folder_name.includes("/") || folder_name.includes("\\")) {
		throw new Error(`Folder name must be a single top-level marketplace folder name: ${folder_name}`);
	}

	const marketplace_root = options.marketplace_root ?? join(process.cwd(), "marketplace");
	const module_root = join(marketplace_root, folder_name);
	if (!(await directory_exists(module_root))) {
		throw new Error(`Marketplace folder not found: ${module_root}`);
	}

	const archive_name = `${folder_name}.tar.gz`;
	const archive_path = join(marketplace_root, archive_name);

	// Relative archive path/args only - GNU tar on Windows mis-parses an
	// absolute path with a drive-letter colon (e.g. "C:\...") as a
	// "host:path" remote-shell spec, so everything runs with cwd=marketplace_root.
	const tar_process = Bun.spawn(["tar", "-czf", archive_name, folder_name], {
		cwd: marketplace_root,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exit_code = await tar_process.exited;
	if (exit_code !== 0) {
		throw new Error(`tar exited with code ${exit_code}.`);
	}

	return archive_path;
}
