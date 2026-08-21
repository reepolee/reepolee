import { describe, expect, test } from "bun:test";

import type { Dev_app_link } from "$config/apps";
import { visible_apps } from "./index";

const apps: Dev_app_link[] = [
	{ name: "main", icon: "dashboard", port_env: "PORT", default_port: 2338, module: null, port: 2338, url: "http://localhost:2338/", current: true },
	{ name: "reeman", icon: "settings", port_env: "REEMAN_PORT", default_port: 2339, module: "system", port: 2339, url: "http://localhost:2339/", current: false },
	{ name: "reeqa", icon: "qa", port_env: "REEQA_PORT", default_port: 2340, module: "system", port: 2340, url: "http://localhost:2340/", current: false },
];

describe("visible development apps", () => {
	test("keeps public apps and apps granted by the current user", () => {
		expect(visible_apps({ current_user: { modules_tags: "system" } }, apps).map((app) => app.name)).toEqual(["main", "reeman", "reeqa"]);
	});

	test("hides module-gated apps from anonymous users", () => {
		expect(visible_apps({ current_user: null }, apps).map((app) => app.name)).toEqual(["main"]);
	});
});
