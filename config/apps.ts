export type Dev_app_name = "main" | "reeman" | "reeqa";

export type Dev_app_definition = {
	name: Dev_app_name;
	icon: "dashboard" | "settings" | "qa";
	port_env: string;
	default_port?: number;
	module: string | null;
};

export type Dev_app_link = Dev_app_definition & {
	port: number;
	url: string;
	current: boolean;
};

/** Static app registry - app processes remain separate in development. */
export const DEV_APP_DEFINITIONS: readonly Dev_app_definition[] = [
	{ name: "main", icon: "dashboard", port_env: "PORT", default_port: 2338, module: null },
	{ name: "reeman", icon: "settings", port_env: "REEMAN_PORT", default_port: 2339, module: "system" },
	{ name: "reeqa", icon: "qa", port_env: "REEQA_PORT", module: "system" },
];

type App_env = Record<string, string | undefined>;

function app_port(definition: Dev_app_definition, env: App_env): number {
	const raw_port = env[definition.port_env]?.trim();
	const configured_port = Number(raw_port);
	if (Number.isInteger(configured_port) && configured_port > 0 && configured_port <= 65_535) return configured_port;
	if (definition.default_port !== undefined) return definition.default_port;
	throw new Error(`Required environment variable ${definition.port_env} must be a valid TCP port`);
}

/** Resolve the public origin used when separate development apps are exposed. */
function app_origin(env: App_env): string {
	for (const name of ["SITE_URL", "MAIN_APP_URL"]) {
		const raw = env[name]?.trim();
		if (!raw || raw === "N/A") continue;
		try {
			const url = new URL(raw);
			if (url.protocol !== "http:" && url.protocol !== "https:") continue;
			return `${url.protocol}//${url.hostname}`;
		} catch {
			// Ignore malformed optional origins and use the local fallback.
		}
	}
	return "http://localhost";
}

/** Build app-switcher links from the configured public origin and app ports. */
export function dev_app_links(current_app: Dev_app_name, env: App_env = Bun.env): Dev_app_link[] {
	const origin = app_origin(env);
	return DEV_APP_DEFINITIONS.map((definition) => {
		const port = app_port(definition, env);
		return {
			...definition,
			port,
			url: `${origin}:${port}/`,
			current: definition.name === current_app,
		};
	});
}
