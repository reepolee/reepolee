/**
 * Resource CLI argument parsing - one parseArgs call for the whole layer.
 *
 * The parsed `ResourceFlags` object travels through main -> runner -> helpers
 * instead of the raw argv array that every function used to re-scan with
 * indexOf. The CLI surface (flag names, positional commands) is unchanged -
 * reeman drives this entry point as a subprocess.
 */

import { parseArgs } from "node:util";

export interface ResourceFlags {
	force: boolean;
	translate: boolean;
	/** Raw --prefix value; normalize with normalize_prefix() where needed. */
	prefix: string;
	/** Parent table for nested CRUD (--parent). */
	parent: string;
	route_name: string;
	pagination: "cursor" | "offset" | undefined;
}

export function parse_resource_args(argv: string[]): { command: string | undefined; param: string | undefined; flags: ResourceFlags; } {
	const { values, positionals } = parseArgs({
		args: argv,
		options: {
			force: { type: "boolean", default: false },
			translate: { type: "boolean", default: false },
			prefix: { type: "string", default: "" },
			parent: { type: "string", default: "" },
			"route-name": { type: "string", default: "" },
			pagination: { type: "string" },
		},
		allowPositionals: true,
		strict: false,
	});

	const raw_pagination = values.pagination;
	const pagination: "cursor" | "offset" | undefined = raw_pagination === "cursor" || raw_pagination === "offset" ? raw_pagination : undefined;

	return {
		command: positionals[0] !== undefined ? String(positionals[0]) : undefined,
		param: positionals[1] !== undefined ? String(positionals[1]) : undefined,
		flags: {
			force: Boolean(values.force),
			translate: Boolean(values.translate),
			prefix: String(values.prefix ?? ""),
			parent: String(values.parent ?? ""),
			route_name: String(values["route-name"] ?? ""),
			pagination,
		},
	};
}
