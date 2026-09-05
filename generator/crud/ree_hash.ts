import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const REE_HASH_MARKER = /\n?<!-- GEN:HASH:sha256:([a-f0-9]{64}) -->\s*$/;
const GENERATED_REE_FILES = ["form.ree", "index.ree", "index_rows.ree"] as const;

export type ReeHashStatus = "clean" | "modified" | "untracked" | null;

type CachedHashStatus = {
	fingerprint: string;
	status: ReeHashStatus;
};

const hash_status_cache = new Map<string, CachedHashStatus>();

function content_without_hash_marker(content: string): string {
	const normalized_content = content.replaceAll("\r\n", "\n");
	const markerless_content = normalized_content.replace(REE_HASH_MARKER, "");
	return markerless_content.endsWith("\n") ? markerless_content.slice(0, -1) : markerless_content;
}

function hash_content(content: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(content);
	return hasher.digest("hex");
}

export async function stamp_generated_ree_hashes(route_dir: string): Promise<void> {
	for (const file_name of GENERATED_REE_FILES) {
		const file_path = join(route_dir, file_name);
		const file = Bun.file(file_path);
		if (!(await file.exists())) continue;
		const content = await file.text();
		const unhashed_content = content_without_hash_marker(content);
		const hash = hash_content(unhashed_content);
		const stamped_content = `${unhashed_content}\n<!-- GEN:HASH:sha256:${hash} -->\n`;
		await Bun.write(file_path, stamped_content);
	}
}

export function inspect_generated_ree_hashes(route_dir: string): ReeHashStatus {
	const fingerprint_parts: string[] = [];
	for (const file_name of GENERATED_REE_FILES) {
		const file_path = join(route_dir, file_name);
		const file_stat = statSync(file_path, { throwIfNoEntry: false });
		if (!file_stat?.isFile()) continue;
		fingerprint_parts.push(`${file_name}:${file_stat.size}:${file_stat.mtimeMs}`);
	}

	if (fingerprint_parts.length === 0) return null;
	const fingerprint = fingerprint_parts.join("|");
	const cached_status = hash_status_cache.get(route_dir);
	if (cached_status?.fingerprint === fingerprint) return cached_status.status;

	let found_generated_file = false;
	let found_untracked_file = false;

	for (const file_name of GENERATED_REE_FILES) {
		const file_path = join(route_dir, file_name);
		const file_stat = statSync(file_path, { throwIfNoEntry: false });
		if (!file_stat?.isFile()) continue;
		found_generated_file = true;
		const content = readFileSync(file_path, "utf-8");
		const marker = content.match(REE_HASH_MARKER);
		if (!marker) {
			found_untracked_file = true;
			continue;
		}
		const current_hash = hash_content(content_without_hash_marker(content));
		if (current_hash !== marker[1]) {
			hash_status_cache.set(route_dir, { fingerprint, status: "modified" });
			return "modified";
		}
	}

	if (!found_generated_file) return null;
	const status = found_untracked_file ? "untracked" : "clean";
	hash_status_cache.set(route_dir, { fingerprint, status });
	return status;
}
