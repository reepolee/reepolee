export function normalize_visual_diff(source_path: string, destination_path: string): void {
	const executable = Bun.which("vips");
	if (!executable) throw new Error("libvips is required to normalize visual E2E differences.");
	const result = Bun.spawnSync([
		executable,
		"extract_band",
		source_path,
		destination_path,
		"0",
		"--n",
		"3",
	], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode === 0) return;
	const stderr_text = result.stderr.toString();
	const error_message = stderr_text.trim();
	throw new Error(error_message || `Could not normalize visual E2E difference: ${source_path}`);
}
