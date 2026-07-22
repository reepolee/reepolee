import { isAbsolute, relative, resolve, sep } from "node:path";

export function normalize_storage_folder(folder: string | undefined): string {
	const normalized = folder?.trim() ?? "";
	if (!normalized) return "";
	if (normalized.startsWith("/") || normalized.endsWith("/") || normalized.includes("\\") || normalized.includes("\0")) {
		throw new Error("Invalid storage folder");
	}

	const segments = normalized.split("/");
	if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes(":") || segment !== segment.trim())) {
		throw new Error("Invalid storage folder");
	}

	return segments.join("/");
}

export function normalize_storage_key(storage_key: string): string {
	const normalized = normalize_storage_folder(storage_key);
	if (!normalized) throw new Error("Invalid storage key");
	return normalized;
}

export function resolve_local_storage_path(storage_root: string, bucket: string, storage_key: string): string {
	const normalized_bucket = normalize_storage_key(bucket);
	const bucket_root = resolve(storage_root, ...normalized_bucket.split("/"));
	const normalized_key = normalize_storage_key(storage_key);
	const output_path = resolve(bucket_root, ...normalized_key.split("/"));
	const relative_path = relative(bucket_root, output_path);
	if (!relative_path || relative_path === ".." || relative_path.startsWith(`..${sep}`) || isAbsolute(relative_path)) {
		throw new Error("Storage path escapes bucket");
	}

	return output_path;
}
