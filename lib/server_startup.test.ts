import { describe, expect, test } from "bun:test";

import { log_server_addresses } from "./server_startup";

describe("log_server_addresses", () => {
	test("always logs localhost alongside a configured DNS host", () => {
		const original_log = console.log;
		const lines: string[] = [];
		const original_server_name = Bun.env.SERVER_NAME;
		console.log = ((...args: unknown[]) => lines.push(args.join(" "))) as typeof console.log;
		Bun.env.SERVER_NAME = "dev.example.test";

		try {
			log_server_addresses({ port: 2338 } as Bun.Server<any>, false, true, false);
		} finally {
			console.log = original_log;
			if (original_server_name === undefined) delete Bun.env.SERVER_NAME;
			else Bun.env.SERVER_NAME = original_server_name;
		}

		const output = lines.join("\n");
		expect(output).toContain("http://localhost:2338/");
		expect(output).toContain("http://dev.example.test:2338/");
	});

	test("does not duplicate localhost when it is the configured host", () => {
		const original_log = console.log;
		const lines: string[] = [];
		const original_server_name = Bun.env.SERVER_NAME;
		console.log = ((...args: unknown[]) => lines.push(args.join(" "))) as typeof console.log;
		Bun.env.SERVER_NAME = "localhost";

		try {
			log_server_addresses({ port: 2338 } as Bun.Server<any>, false, true, false);
		} finally {
			console.log = original_log;
			if (original_server_name === undefined) delete Bun.env.SERVER_NAME;
			else Bun.env.SERVER_NAME = original_server_name;
		}

		const visible_lines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trim());
		expect(visible_lines.filter((line) => line === "http://localhost:2338/").length).toBe(1);
	});
});
