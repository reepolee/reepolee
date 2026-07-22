/**
 * Object manipulation utilities - extracted from lib/helpers.ts
 *
 * Functions for deep merging, diffing, field merging, nested property access,
 * and reading JSON files.
 */

import { readFileSync } from "node:fs";

import type { FormFieldDef } from "$generator/schema/types";

export function get_nested(obj: any, path: string): any {
	if (!path || !obj) return {};

	// Split on both / and . to support different caller conventions
	const parts = path.split(/[./]/);

	let current = obj;

	for (const part of parts) {
		if (!current || typeof current !== "object") { return {}; }

		current = current[part];
	}

	return current ?? {};
}

export function deep_merge(target: any, source: any): any {
	for (const key of Object.keys(source ?? {})) {
		const sv = source[key];
		const tv = target[key];

		if (sv && typeof sv === "object" && !Array.isArray(sv) && tv && typeof tv === "object" && !Array.isArray(tv)) {
			deep_merge(tv, sv);
		} else {
			target[key] = sv;
		}
	}
	return target;
}

/**
 * Merge generated field definitions with user-defined overrides.
 * Deeply merges the `attributes` sub-object for each overridden field.
 */
export function merge_fields(generated_fields: Record<string, FormFieldDef>, overrides: Record<string, Partial<FormFieldDef>>): Record<string, FormFieldDef> {
	return Object.fromEntries(Object.entries(generated_fields).map(([k, v]) => [
		k,
		k in overrides ? ({ ...v, ...overrides[k], attributes: { ...v.attributes, ...overrides[k].attributes } } as FormFieldDef) : v,
	]));
}

// Read a JSON file, returning {} on any error.
export function read_json(file_path: string): Record<string, any> {
	try {
		return JSON.parse(readFileSync(file_path, "utf-8"));
	} catch {
		return {};
	}
}

export function updated_diff<T extends Record<string, unknown>>(original: T, updated: T): Partial<T> { return Object.fromEntries(Object.entries(updated).filter(([k, v]) => original[k] !== v)) as Partial<T>; }
