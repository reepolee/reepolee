import { join } from "node:path";

import { sanitize_env_value } from "$lib/env";

import type { Qa_project } from "./project_store";

/**
 * Read a *target project's* .env file. Bun's own env loading only ever
 * populates the current process, so it cannot answer "what is ADMIN_USERNAME
 * in the project under test" - which is the only question a workflow step's
 * `value_env` asks. No interpolation, no multi-line values, no .env.local
 * layering: a step names one variable and gets its value.
 */
export function parse_env_file(text: string): Record<string, string> {
	const values: Record<string, string> = {};
	for (const raw_line of text.split("\n")) {
		const line = raw_line.trim();
		if (!line || line.startsWith("#")) continue;
		const assignment = line.startsWith("export ") ? line.slice("export ".length) : line;
		const separator = assignment.indexOf("=");
		if (separator <= 0) continue;
		const name = assignment.slice(0, separator).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
		values[name] = sanitize_env_value(assignment.slice(separator + 1));
	}
	return values;
}

export async function read_project_env(project: Qa_project): Promise<Record<string, string>> {
	const file = Bun.file(join(project.path, ".env"));
	if (!(await file.exists())) return {};
	return parse_env_file(await file.text());
}
