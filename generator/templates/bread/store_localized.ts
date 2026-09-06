/**
 * BREAD resource store - __resource.exact__ (localized)
 *
 * This is a stub. It replaces the SQL query layer a DB-backed CRUD table
 * would get: there is no table behind this resource, so every function
 * below is a placeholder that returns a safe empty value. Implement each
 * one against whatever actually holds this resource's data (per-locale
 * JSON files, an external API, memory, etc.) - the signatures below are
 * exactly what the generated index.ts and form.ree call, so keep them
 * intact. `locale_code` follows the same convention as localized DB-backed
 * CRUD: empty string means the default locale.
 */

export const RESOURCE_NAME = "__resource.exact__";

export interface Item {
	__interface.fields__
}

export interface Options {
	option_value: number | string;
	option_text: string;
}

// TODO: return every item for the given locale.
export async function get_all_items(locale_code: string = ""): Promise<Item[]> {
	return [];
}

// TODO: return { option_value, option_text } pairs for select/autocomplete inputs.
export async function get___resource.exact___select_options(locale_code: string = ""): Promise<Options[]> {
	return [];
}

// TODO: return the item with this id in the given locale, or undefined if it does not exist.
export async function get_item_by_id(id: __store.id_type__, locale_code: string = ""): Promise<Item | undefined> {
	return undefined;
}

// TODO: return the matching page of items plus the total count, for the given locale.
export async function search_items(search: string = "", offset: number = 0, limit: number = 20, order_by: string = "id::asc", scope_clause: string = "", filter_clauses: { clause: string; params: any[] }[] = [], locale_code: string = ""): Promise<{ items: Item[], total: number }> {
	return { items: [], total: 0 };
}

// TODO: persist a new item (in the given locale, if the store separates content by locale) and return it (with its assigned id).
export async function create_item(item: __store.create_item_arg__, locale_code: string = ""): Promise<Item> {
	return { id: 0, ...item } as Item;
}

// TODO: persist changes to an existing item in the given locale and return the updated item.
export async function update_item(id: __store.id_type__, item: __store.update_item_arg__, locale_code: string = ""): Promise<Item | undefined> {
	return undefined;
}

// TODO: remove the item (from the given locale, or every locale, depending on the store) and return whether it existed.
export async function delete_item(id: __store.id_type__, locale_code: string = ""): Promise<boolean> {
	return false;
}
