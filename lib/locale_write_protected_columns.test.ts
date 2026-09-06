import { describe, expect, test } from "bun:test";

import type { FanOutOptions } from "./locale_write";

describe("locale write contract", () => {
	test("supports protected base-owned columns in fan-out options", () => {
		const options: FanOutOptions = {
			table_name: "sensors",
			localized_columns: ["label"],
			write_columns: ["id", "label", "device_id", "created_at"],
			update_columns: ["label"],
			protected_columns: ["device_id", "created_at"],
		};

		expect(options.protected_columns).toEqual(["device_id", "created_at"]);
		expect(options.update_columns).toEqual(["label"]);
	});
});
