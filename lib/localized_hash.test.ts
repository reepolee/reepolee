/**
 * Hashing is representation-insensitive on purpose: the same fact arrives as a
 * number from the database and a string from a form round-trip, and a copy
 * that was never touched must not read as edited.
 */

import { describe, expect, test } from "bun:test";

import { hash_localized_value, serialize_for_hash, values_match } from "./localized_hash";

describe("serialize_for_hash", () => {
	test("treats null and undefined as empty", () => {
		expect(serialize_for_hash(null)).toBe("");
		expect(serialize_for_hash(undefined)).toBe("");
	});

	test("normalizes numeric strings to their number form", () => {
		expect(serialize_for_hash("10.50")).toBe(serialize_for_hash(10.5));
		expect(serialize_for_hash("42")).toBe(serialize_for_hash(42));
	});

	test("normalizes booleans to 1/0", () => {
		expect(serialize_for_hash(true)).toBe("1");
		expect(serialize_for_hash(false)).toBe("0");
	});

	test("normalizes CRLF to LF so an untouched textarea is not 'edited'", () => {
		expect(serialize_for_hash("a\r\nb")).toBe("a\nb");
	});

	test("sorts object keys so key order never changes the hash", () => {
		expect(serialize_for_hash({ b: 1, a: 2 })).toBe(serialize_for_hash({ a: 2, b: 1 }));
	});

	test("keeps ordinary text intact", () => {
		expect(serialize_for_hash("Zero ceremony")).toBe("Zero ceremony");
	});
});

describe("values_match", () => {
	test("matches across representations", () => {
		expect(values_match("10.50", 10.5)).toBe(true);
		expect(values_match("text\r\nline", "text\nline")).toBe(true);
	});

	test("does not match genuinely different values", () => {
		expect(values_match("Zero ceremony", "Nič ceremonije")).toBe(false);
		expect(values_match(1, 2)).toBe(false);
	});
});

describe("hash_localized_value", () => {
	test("is stable for the same fact and differs for different ones", () => {
		expect(hash_localized_value("abc")).toBe(hash_localized_value("abc"));
		expect(hash_localized_value("abc")).not.toBe(hash_localized_value("abd"));
	});

	test("hashes equal facts in different representations alike", () => {
		expect(hash_localized_value("10.50")).toBe(hash_localized_value(10.5));
	});
});
