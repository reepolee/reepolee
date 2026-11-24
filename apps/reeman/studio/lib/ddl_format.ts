import type { Dialect } from "./types";

/** Normalize MySQL DDL for a semantic Studio preview comparison. */
export function format_ddl_for_diff(ddl: string, dialect: Dialect): string {
	if (dialect !== "mysql") return ddl;

	const executable = Bun.which("reesql");
	if (!executable) throw new Error("reesql is required to format MySQL DDL previews. Run: bun run get:reesql");

	const process = Bun.spawnSync({
		cmd: [executable, "--stdin"],
		stdin: new TextEncoder().encode(ddl),
		stdout: "pipe",
		stderr: "pipe",
	});
	if (process.exitCode !== 0) {
		const error = new TextDecoder().decode(process.stderr).trim();
		throw new Error(error || "reesql could not format MySQL DDL.");
	}
	return new TextDecoder().decode(process.stdout);
}
