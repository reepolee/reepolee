#!/usr/bin/env bun
/**
 * Add translation keys for username-based login.
 */
import { SQL } from "bun";

const url = (Bun.env.CONNECTION_STRING ?? "").replace(/^["']|["']$/g, "").trim();
const db = new SQL(url);
const alive = setInterval(() => {}, 2_147_483_647);

try {
	await db`INSERT IGNORE INTO translations (lang, namespace, key_path, translation) VALUES ('en', 'system.auth.login', 'labels.username_or_email', 'Username or Email')`;
	await db`INSERT IGNORE INTO translations (lang, namespace, key_path, translation) VALUES ('sl', 'system.auth.login', 'labels.username_or_email', 'Uporabniško ime ali e-pošta')`;
	await db`INSERT IGNORE INTO translations (lang, namespace, key_path, translation) VALUES ('en', 'system.auth.login', 'errors.username_required', 'Username is required.')`;
	await db`INSERT IGNORE INTO translations (lang, namespace, key_path, translation) VALUES ('sl', 'system.auth.login', 'errors.username_required', 'Uporabniško ime je obvezno.')`;
	await db`INSERT IGNORE INTO translations (lang, namespace, key_path, translation) VALUES ('en', 'system.auth.login', 'errors.invalid_username_or_password', 'Invalid username or password.')`;
	await db`INSERT IGNORE INTO translations (lang, namespace, key_path, translation) VALUES ('sl', 'system.auth.login', 'errors.invalid_username_or_password', 'Napačno uporabniško ime ali geslo.')`;
	await db`INSERT IGNORE INTO translations (lang, namespace, key_path, translation) VALUES ('en', 'system.auth.invite', 'errors.username_required', 'Username is required.')`;
	await db`INSERT IGNORE INTO translations (lang, namespace, key_path, translation) VALUES ('sl', 'system.auth.invite', 'errors.username_required', 'Uporabniško ime je obvezno.')`;
	await db`INSERT IGNORE INTO translations (lang, namespace, key_path, translation) VALUES ('en', 'system.auth.invite', 'errors.username_exists', 'A user with this username already exists.')`;
	await db`INSERT IGNORE INTO translations (lang, namespace, key_path, translation) VALUES ('sl', 'system.auth.invite', 'errors.username_exists', 'Uporabnik s tem uporabniškim imenom že obstaja.')`;
	await db`INSERT IGNORE INTO translations (lang, namespace, key_path, translation) VALUES ('en', 'system.auth.invite', 'labels.username', 'Username')`;
	await db`INSERT IGNORE INTO translations (lang, namespace, key_path, translation) VALUES ('sl', 'system.auth.invite', 'labels.username', 'Uporabniško ime')`;
	await db`INSERT IGNORE INTO translations (lang, namespace, key_path, translation) VALUES ('en', 'system.auth.invite', 'ui.username_field', 'Username')`;
	await db`INSERT IGNORE INTO translations (lang, namespace, key_path, translation) VALUES ('sl', 'system.auth.invite', 'ui.username_field', 'Uporabniško ime')`;

	const check = await db`SELECT COUNT(*) as cnt FROM translations WHERE key_path IN ('username_or_email','username_required')`;
	console.log(`✓ Inserted. Keys found: ${check[0]?.cnt ?? 0}`);
} finally {
	clearInterval(alive);
	await db.close();
}
