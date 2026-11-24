/**
 * Canonical serialization and hashing of localized values.
 *
 * Lives on its own so both the copy layer (which stamps a hash of the source
 * at copy time) and the stale-copy check (which compares that hash against the
 * source's current value) can use it without importing each other.
 */

/**
 * Canonical string form of a value.
 *
 * Deliberately representation-insensitive: the same fact can arrive as a
 * number from the database and a string from a form round-trip, and "10.50" is
 * the same price as 10.5. Normalizing keeps those from reading as a change.
 */
export function serialize_for_hash(value: unknown): string {
	if (value === null || value === undefined) return "";

	if (typeof value === "boolean") return value ? "1" : "0";

	if (typeof value === "number") return String(value);

	if (typeof value === "object") return stable_stringify(value);

	const as_string = String(value);

	// A numeric string and its number form must hash alike - SQLite hands back
	// whichever the column type implies, and a form always submits a string.
	if (as_string.trim() !== "" && !Number.isNaN(Number(as_string))) {
		const as_number = Number(as_string);
		if (Number.isFinite(as_number)) return String(as_number);
	}

	// Textareas submit CRLF per the HTML spec while the stored value has LF, so
	// an untouched multi-line copy would otherwise read as edited and lose its
	// provenance on the first save.
	return as_string.replaceAll("\r\n", "\n");
}

/** JSON.stringify with object keys sorted, so key order never changes the hash. */
function stable_stringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "";
	if (Array.isArray(value)) {
		const items = value.map((item) => stable_stringify(item));
		return `[${items.join(",")}]`;
	}
	const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
	const pairs = entries.map(([key, item]) => `${JSON.stringify(key)}:${stable_stringify(item)}`);
	return `{${pairs.join(",")}}`;
}

export function hash_localized_value(value: unknown): string {
	const serialized = serialize_for_hash(value);
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(serialized);
	return hasher.digest("hex");
}

/** Whether two values are the same fact, ignoring representation. */
export function values_match(left: unknown, right: unknown): boolean {
	return serialize_for_hash(left) === serialize_for_hash(right);
}
