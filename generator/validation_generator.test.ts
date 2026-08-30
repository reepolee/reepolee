import { describe, expect, test } from "bun:test";

import { collect_validation_error_keys, generate_zod_fields_from_array, generate_validation_server_content } from "./validation_generator";
import type { FieldDef } from "./crud/types";

const required_select: FieldDef = {
	name: "status",
	type: "select",
	required: true,
	is_nullable: false,
	min: undefined,
	max: undefined,
	attributes: { options: ["draft", "published", "archived"] },
};

const optional_select: FieldDef = {
	name: "status",
	type: "select",
	required: false,
	is_nullable: true,
	min: undefined,
	max: undefined,
	attributes: { options: ["draft", "published"] },
};

describe("generate_zod_fields_from_array select-with-options (enum)", () => {
	test("required select adds the empty placeholder sentinel + required refine, no enum .min", () => {
		const out = generate_zod_fields_from_array([required_select], "validate");
		expect(out).toContain('z.enum(["draft","published","archived",""])');
		expect(out).toContain(`.refine((v) => v !== "", { message: "status_required" })`);
		// Zod 4.5 enums have no .min/.max - the old chain must be gone.
		expect(out).not.toContain(".min(1");
		expect(out).not.toContain(".min(");
	});

	test("optional select accepts the empty placeholder (no refine)", () => {
		const out = generate_zod_fields_from_array([optional_select], "validate");
		expect(out).toContain('z.enum(["draft","published",""])');
		expect(out).not.toContain("status_required");
	});

	test("collect_validation_error_keys emits only status_required for a required select", () => {
		const keys = collect_validation_error_keys([required_select]);
		expect(keys).toEqual([{ key: "status_required", value: "Status is required." }]);
	});

	test("collect_validation_error_keys emits nothing for an optional select", () => {
		expect(collect_validation_error_keys([optional_select])).toEqual([]);
	});
});

describe("generated validation_server for a required select validates end-to-end", () => {
	test("empty placeholder -> required key; valid option passes; off-list rejected", async () => {
		const zod_fields = generate_zod_fields_from_array([required_select], "validate");
		const content = await generate_validation_server_content("", "", zod_fields);

		const dir = `${import.meta.dir}/.tmp_enum_validation`;
		await Bun.write(`${dir}/validation_server.ts`, content);
		try {
			const mod = await import(`${dir}/validation_server.ts`);

			const valid = mod.validate({ status: "published" });
			expect(valid[0]).toEqual({});
			expect(valid[1]).toEqual({ status: "published" });

			const empty = mod.validate({ status: "" });
			expect(empty[0]).toEqual({ status: "status_required" });
			expect(empty[1]).toBeNull();

			const off_list = mod.validate({ status: "bogus" });
			// Off-list values are rejected by the enum itself (not a keyed error).
			expect(Object.keys(off_list[0])).toEqual(["status"]);
			expect(off_list[0].status).toMatch(/Invalid/i);
		} finally {
			await Bun.$`rm -rf ${dir}`.quiet();
		}
	});
});
