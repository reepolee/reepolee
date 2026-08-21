export type Dev_app_name = "main" | "reeman" | "reeqa";

export type Dev_app_definition = {
	name: Dev_app_name;
	icon: "dashboard" | "settings" | "qa";
	port_env: string;
	default_port: number;
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
	{ name: "reeqa", icon: "qa", port_env: "REEQA_PORT", default_port: 2340, module: "system" },
];

type App_env = Record<string, string | undefined>;

function app_port(definition: Dev_app_definition, env: App_env): number {
	const configured_port = Number(env[definition.port_env]);
	return Number.isInteger(configured_port) && configured_port > 0 ? configured_port : definition.default_port;
}

/** Build localhost links for the app switcher without coupling apps to one port. */
export function dev_app_links(current_app: Dev_app_name, env: App_env = Bun.env): Dev_app_link[] {
	return DEV_APP_DEFINITIONS.map((definition) => {
		const port = app_port(definition, env);
		return {
			...definition,
			port,
			url: `http://localhost:${port}/`,
			current: definition.name === current_app,
		};
	});
}
