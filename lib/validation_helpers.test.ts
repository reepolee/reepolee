import "$lib/temporal";
import { describe, expect, test } from "bun:test";

// Fallback TIME_ZONE so sql_to_datetime_local() doesn't throw when .env is absent (e.g. fresh clone).
// Bun auto-loads .env when present, but .env is gitignored.
process.env.TIME_ZONE ??= "UTC";

const vh = await import("./validation_helpers");
const { z } = await import("$root/vendor/zod.min.js");

describe("validation_helpers", () => {
	describe("z_date_required", () => {
		test("passes valid date string", () => {
			const result = vh.z_date_required.safeParse("2026-05-15");
			expect(result.success).toBe(true);
			if (result.success) expect(result.data).toBe("2026-05-15");
		});

		test("rejects empty string", () => {
			const result = vh.z_date_required.safeParse("");
			expect(result.success).toBe(false);
		});

		test("rejects null", () => {
			const result = vh.z_date_required.safeParse(null);
			expect(result.success).toBe(false);
		});

		test("rejects invalid format", () => {
			const result = vh.z_date_required.safeParse("2026/05/15");
			expect(result.success).toBe(false);
		});
	});

	describe("z_date_optional", () => {
		test("passes valid date", () => {
			const result = vh.z_date_optional.safeParse("2026-05-15");
			expect(result.success).toBe(true);
			if (result.success) expect(result.data).toBe("2026-05-15");
		});

		test("transforms empty string to null", () => {
			const result = vh.z_date_optional.safeParse("");
			expect(result.success).toBe(true);
			if (result.success) expect(result.data).toBeNull();
		});

		test("passes null through to null", () => {
			const result = vh.z_date_optional.safeParse(null);
			expect(result.success).toBe(true);
			if (result.success) expect(result.data).toBeNull();
		});

		test("rejects invalid format", () => {
			const result = vh.z_date_optional.safeParse("invalid");
			expect(result.success).toBe(false);
		});
	});

	describe("z_datetime_optional", () => {
		test("passes valid datetime-local format", () => {
			const result = vh.z_datetime_optional.safeParse("2026-05-15T10:30");
			expect(result.success).toBe(true);
			if (result.success) expect(result.data).toBe("2026-05-15T10:30");
		});

		test("transforms empty string to null", () => {
			const result = vh.z_datetime_optional.safeParse("");
			expect(result.success).toBe(true);
			if (result.success) expect(result.data).toBeNull();
		});

		test("passes null through to null", () => {
			const result = vh.z_datetime_optional.safeParse(null);
			expect(result.success).toBe(true);
			if (result.success) expect(result.data).toBeNull();
		});

		test("rejects invalid format", () => {
			const result = vh.z_datetime_optional.safeParse("not-a-datetime");
			expect(result.success).toBe(false);
		});
	});

	describe("z_datetime_required", () => {
		test("passes valid datetime string", () => {
			const result = vh.z_datetime_required.safeParse("2026-05-15T10:30");
			expect(result.success).toBe(true);
			if (result.success) expect(result.data).toBe("2026-05-15T10:30");
		});

		test("rejects empty string", () => {
			const result = vh.z_datetime_required.safeParse("");
			expect(result.success).toBe(false);
		});

		test("rejects null", () => {
			const result = vh.z_datetime_required.safeParse(null);
			expect(result.success).toBe(false);
		});

		test("rejects invalid format", () => {
			const result = vh.z_datetime_required.safeParse("bad");
			expect(result.success).toBe(false);
		});
	});

	describe("date_codec", () => {
		test("decode: converts Date to locale date string", () => {
			const d = new Date(Date.UTC(2026, 4, 15));
			const decoded = vh.date_codec.decode(d);
			expect(decoded).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		});

		test("decode: passes string through", () => {
			const decoded = vh.date_codec.decode("2026-05-15");
			expect(decoded).toBe("2026-05-15");
		});

		test("decode: null returns null", () => expect(vh.date_codec.decode(null)).toBeNull());
	});

	describe("datetime_codec", () => {
		test("decode: converts Date to datetime-local format", () => {
			const d = new Date(Date.UTC(2026, 4, 15, 10, 30));
			const result = vh.datetime_codec.decode(d);
			expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
		});

		test("decode: converts SQLite string to datetime-local format", () => {
			const result = vh.datetime_codec.decode("2026-05-15 10:30:00");
			expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
		});

		test("decode: null returns null", () => expect(vh.datetime_codec.decode(null)).toBeNull());
	});

	describe("timestamp_codec", () => {
		test("decode: converts Date to UTC wall-clock string", () => {
			const d = new Date(2026, 4, 15, 10, 30, 0);
			const result = vh.timestamp_codec.decode(d);
			expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
		});

		test("decode: passes string through", () => {
			const result = vh.timestamp_codec.decode("2026-05-15 10:30:00");
			expect(result).toBe("2026-05-15 10:30:00");
		});

		test("decode: null returns null", () => expect(vh.timestamp_codec.decode(null)).toBeNull());
	});

	describe("empty_string codec", () => {
		test("decode: empty string to null", () => expect(vh.empty_string.decode("")).toBeNull());

		test("decode: null to null", () => expect(vh.empty_string.decode(null)).toBeNull());

		test("decode: non-empty string unchanged", () => expect(vh.empty_string.decode("hello")).toBe("hello"));

		test("encode: string to string", () => expect(vh.empty_string.encode("hello")).toBe("hello"));

		test("encode: null to null", () => expect(vh.empty_string.encode(null)).toBeNull());
	});

	describe("datetime_codec - catch blocks", () => {
		test("decode: returns null for invalid string input (catch block)", () => {
			// sql_to_datetime_local should throw on garbage input -> catch returns null
			const result = vh.datetime_codec.decode("garbage");
			expect(result).toBeNull();
		});

		test("decode: returns null for empty string", () => expect(vh.datetime_codec.decode("")).toBeNull());

		test("encode: null to null", () => expect(vh.datetime_codec.encode(null)).toBeNull());

		test("encode: string to string", () => expect(vh.datetime_codec.encode("2026-05-15T10:30")).toBe("2026-05-15T10:30"));
	});

	describe("date_codec - encode", () => {
		test("encode: null to null", () => expect(vh.date_codec.encode(null)).toBeNull());

		test("encode: string to string", () => expect(vh.date_codec.encode("2026-05-15")).toBe("2026-05-15"));
	});

	describe("timestamp_codec - encode", () => {
		test("encode: null to null", () => expect(vh.timestamp_codec.encode(null)).toBeNull());

		test("encode: string to string", () => expect(vh.timestamp_codec.encode("2026-05-15 10:30:00")).toBe("2026-05-15 10:30:00"));
	});

	describe("validate_schema", () => {
		test("returns clean data when validation passes", () => {
			const schema = z.object({ name: z.string() });
			const [errors, data] = vh.validate_schema(schema, { name: "Alice" });
			expect(errors).toEqual({});
			expect(data).toEqual({ name: "Alice" });
		});

		test("returns errors for invalid data", () => {
			const schema = z.object({ email: z.string().email() });
			const [errors, data] = vh.validate_schema(schema, { email: "bad" });
			expect(errors.email).toBeDefined();
			expect(data).toBeNull();
		});

		test("returns errors only for touched fields", () => {
			const schema = z.object({ name: z.string().min(1), email: z.string().email() });
			const [errors, data] = vh.validate_schema(schema, { name: "", email: "bad" }, ["name"]);
			expect(errors.name).toBeDefined();
			expect(errors.email).toBeUndefined();
			expect(data).toBeNull();
		});

		test("overrides error messages with custom map", () => {
			const schema = z.object({ name: z.string().min(1, "Name is required") });
			const [errors] = vh.validate_schema(schema, { name: "" }, ["name"], { "Name is required": "Vnesite ime" });
			expect(errors.name).toBe("Vnesite ime");
		});
	});
});
