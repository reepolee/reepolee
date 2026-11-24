import { describe, expect, test } from "bun:test";

import { expected_locale_tables } from "./expected_schema";
import type { SchemaObject } from "../schema/types";

describe("expected locale tables", () => {
	test("does not clone foreign keys into locale sidecars", () => {
		const base_schema: SchemaObject = {
			type: "table",
			name: "sensors",
			columns: [
				{ name: "name", type_string: "TEXT", comment: "", is_nullable: false, is_primary_key: false, is_auto_increment: false },
				{ name: "device_id", type_string: "INTEGER", comment: "", is_nullable: false, is_primary_key: false, is_auto_increment: false },
			],
			foreign_keys: [{
				constraint_name: "fk_sensors_device_id",
				column_name: "device_id",
				referenced_table_name: "devices",
				referenced_column_name: "id",
			}],
			has_view: false,
		};

		const [locale_table] = expected_locale_tables({
			base_schema,
			localized_field_names: ["name"],
			locale_codes: ["en-us", "sl-si"],
			default_locale_code: "en-us",
			localized_tables: new Set(["sensors"]),
		});

		expect(locale_table?.foreign_keys).toEqual([]);
	});
});
