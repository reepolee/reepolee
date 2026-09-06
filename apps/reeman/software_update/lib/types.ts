export type FileState = "new" | "modified" | "project-only";

export type SourceCommitInfo = {
	hash: string;
	message: string;
	author: string;
	date: string;
};

export type ScanEntry = {
	/** project-relative path, forward-slash normalized */
	rel_path: string;
	state: FileState;
	source_hash: string | null;
	dest_hash: string | null;
	source_size: number | null;
	dest_size: number | null;
	commit_info: SourceCommitInfo | null;
	ignored: boolean;
	ignore_pattern: string | null;
	is_exact_ignore: boolean;
};

export type ScanSnapshot = {
	scan_id: string;
	source_root: string;
	project_root: string;
	source_head?: string | null;
	created_at: string;
	entries: ScanEntry[];
};

export type ScanSummary = {
	new_count: number;
	modified_count: number;
	project_only_count: number;
	ignored_count: number;
	selectable_count: number;
};

export type ApplyFileResult = {
	rel_path: string;
	ok: boolean;
	reason?: "stale-source" | "stale-dest" | "not-selectable" | "write-error";
};

export type ApplyResult = {
	copied: string[];
	stale: ApplyFileResult[];
	failed: ApplyFileResult[];
};
