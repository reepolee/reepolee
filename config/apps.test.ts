import { describe, expect, test } from "bun:test";

import { dev_app_links } from "./apps";

describe("development app links", () => {
	test("uses main and reeman defaults and requires an explicit ReeQA port", () => {
		const apps = dev_app_links("reeman", { REEQA_PORT: "2340" });

		expect(apps.map((app) => app.url)).toEqual([
			"http://localhost:2338/",
			"http://localhost:2339/",
			"http://localhost:2340/",
		]);
		expect(apps.find((app) => app.name === "reeman")?.current).toBe(true);
		expect(apps.find((app) => app.name === "main")?.module).toBeNull();
	});

	test("does not fall back when ReeQA port is missing or invalid", () => {
		expect(() => dev_app_links("main", {})).toThrow("REEQA_PORT");
		expect(() => dev_app_links("main", { REEQA_PORT: "N/A" })).toThrow("REEQA_PORT");
		expect(() => dev_app_links("main", { REEQA_PORT: "65536" })).toThrow("REEQA_PORT");
	});

	test("uses configured ports while keeping development links on localhost", () => {
		const apps = dev_app_links("main", {
			SERVER_NAME: "127.0.0.1",
			PORT: "2500",
			REEMAN_PORT: "2501",
			REEQA_PORT: "2502",
		});

		expect(apps.map((app) => app.port)).toEqual([2500, 2501, 2502]);
		expect(apps.map((app) => app.url)).toEqual([
			"http://localhost:2500/",
			"http://localhost:2501/",
			"http://localhost:2502/",
		]);
	});
});
