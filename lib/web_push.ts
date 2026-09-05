import { DB_CONNECTION_STRING, db } from "$config/db";
import { create_vapid_authorization, get_web_push_config } from "$config/web_push";
import { enqueue, init_queue } from "$queue/index";

export type Web_push_subscription = {
	endpoint: string;
	keys: { p256dh: string; auth: string };
};

export type Web_push_payload = {
	title: string;
	message: string;
	link?: string;
};

function decode_base64url(value: string): Uint8Array {
	const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
	const binary = atob(padded);
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function encode_hex(value: Uint8Array): string {
	return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function valid_payload(value: unknown): value is Web_push_payload {
	if (!value || typeof value !== "object") return false;
	const item = value as Record<string, unknown>;
	if (typeof item.title !== "string" || item.title.length === 0 || item.title.length > 200) return false;
	if (typeof item.message !== "string" || item.message.length > 4096) return false;
	if (item.link === undefined) return true;
	if (typeof item.link !== "string" || item.link.length > 2048) return false;
	if (item.link.startsWith("/") && !item.link.startsWith("//")) return true;
	try {
		return new URL(item.link).protocol === "https:";
	} catch {
		return false;
	}
}

function safe_push_hostname(hostname: string): boolean {
	const host = hostname.toLowerCase();
	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.includes(":")) return false;
	if (host === "0.0.0.0" || host === "169.254.169.254") return false;
	const octets = host.split(".").map(Number);
	if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return true;
	const first = octets[0] ?? -1;
	const second = octets[1] ?? -1;
	return first !== 10 && first !== 127 && !(first === 172 && second >= 16 && second <= 31) && !(first === 192 && second === 168) && !(first === 169 && second === 254);
}

async function endpoint_hash(endpoint: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
	return encode_hex(new Uint8Array(digest));
}

function valid_subscription(value: unknown): value is Web_push_subscription {
	if (!value || typeof value !== "object") return false;
	const item = value as Record<string, any>;
	const keys = item.keys as Record<string, unknown> | undefined;
	let endpoint: URL;
	try {
		endpoint = new URL(typeof item.endpoint === "string" ? item.endpoint : "");
	} catch {
		return false;
	}
	if (endpoint.protocol !== "https:" || !safe_push_hostname(endpoint.hostname) || item.endpoint.length > 4096) return false;
	try {
		return typeof keys?.p256dh === "string" && decode_base64url(keys.p256dh).length === 65
			&& typeof keys?.auth === "string" && decode_base64url(keys.auth).length === 16;
	} catch {
		return false;
	}
}

/** Persist or refresh one browser subscription for the authenticated user. */
export async function save_web_push_subscription(user_id: number, subscription: unknown): Promise<void> {
	if (!valid_subscription(subscription)) throw new Error("Invalid Web Push subscription.");
	const hash = await endpoint_hash(subscription.endpoint);
	if (DB_CONNECTION_STRING.toLowerCase().startsWith("mysql://")) {
		await db`
			INSERT INTO web_push_subscriptions (user_id, endpoint, endpoint_hash, p256dh, auth)
			VALUES (${user_id}, ${subscription.endpoint}, ${hash}, ${subscription.keys.p256dh}, ${subscription.keys.auth})
			ON DUPLICATE KEY UPDATE
				user_id = ${user_id}, endpoint = ${subscription.endpoint}, p256dh = ${subscription.keys.p256dh}, auth = ${subscription.keys.auth}
		`;
		return;
	}
	await db`
		INSERT INTO web_push_subscriptions (user_id, endpoint, endpoint_hash, p256dh, auth)
		VALUES (${user_id}, ${subscription.endpoint}, ${hash}, ${subscription.keys.p256dh}, ${subscription.keys.auth})
		ON CONFLICT(endpoint_hash) DO UPDATE SET
			user_id = excluded.user_id,
			endpoint = excluded.endpoint,
			p256dh = excluded.p256dh,
			auth = excluded.auth,
			updated_at = CURRENT_TIMESTAMP
	`;
}

export async function remove_web_push_subscription(user_id: number, endpoint: string): Promise<void> {
	const hash = await endpoint_hash(endpoint);
	await db`DELETE FROM web_push_subscriptions WHERE user_id = ${user_id} AND endpoint_hash = ${hash}`;
}

export async function remove_web_push_endpoint(endpoint: string): Promise<void> {
	const hash = await endpoint_hash(endpoint);
	await db`DELETE FROM web_push_subscriptions WHERE endpoint_hash = ${hash}`;
}

/** Queue one notification for every subscription belonging to a user. */
export async function queue_web_push_notification(user_id: number, payload: Web_push_payload): Promise<number> {
	if (!valid_payload(payload)) throw new Error("Invalid Web Push notification payload.");
	await init_queue();
	if (!get_web_push_config()) return 0;
	const rows = await db`SELECT endpoint, p256dh, auth FROM web_push_subscriptions WHERE user_id = ${user_id}`;
	for (const row of rows) {
		await enqueue({ type: "web_push", payload: { endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth, notification: payload } });
	}
	return rows.length;
}

function as_array_buffer(value: Uint8Array): ArrayBuffer {
	return Uint8Array.from(value).buffer as ArrayBuffer;
}

async function hmac(key_bytes: Uint8Array, data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
	const key = await crypto.subtle.importKey("raw", as_array_buffer(key_bytes), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const signature = await crypto.subtle.sign("HMAC", key, as_array_buffer(data));
	return new Uint8Array(new Uint8Array(signature).buffer as ArrayBuffer);
}

async function hkdf_expand(prk: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
	const blocks: Uint8Array[] = [];
	let previous = new Uint8Array(0);
	for (let index = 1; blocks.reduce((total, block) => total + block.length, 0) < length; index++) {
		const input = new Uint8Array(previous.length + info.length + 1);
		input.set(previous);
		input.set(info, previous.length);
		input[input.length - 1] = index;
		previous = await hmac(prk, Uint8Array.from(input));
		blocks.push(previous);
	}
	const output = new Uint8Array(new ArrayBuffer(length));
	let offset = 0;
	for (const block of blocks) {
		const count = Math.min(block.length, length - offset);
		output.set(block.slice(0, count), offset);
		offset += count;
		if (offset === length) break;
	}
	return output;
}

/** Encrypt an RFC 8291 aes128gcm Web Push body. */
export async function encrypt_web_push_payload(subscription: Web_push_subscription, payload: Web_push_payload, salt: Uint8Array, ephemeral_private_key: CryptoKey, ephemeral_public_key: Uint8Array): Promise<Uint8Array> {
	const auth_secret = decode_base64url(subscription.keys.auth);
	const client_public_key = decode_base64url(subscription.keys.p256dh);
	if (auth_secret.length !== 16 || client_public_key.length !== 65 || client_public_key[0] !== 4 || salt.length !== 16 || ephemeral_public_key.length !== 65) {
		throw new Error("Invalid Web Push key material.");
	}
	const client_key = await crypto.subtle.importKey("raw", as_array_buffer(client_public_key), { name: "ECDH", namedCurve: "P-256" }, false, []);
	const shared_secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: client_key }, ephemeral_private_key, 256));
	const auth_prk = await hmac(Uint8Array.from(auth_secret), Uint8Array.from(shared_secret));
	const key_info = new Uint8Array([...new TextEncoder().encode("WebPush: info\0"), ...client_public_key, ...ephemeral_public_key]);
	const ikm = await hkdf_expand(auth_prk, Uint8Array.from(key_info), 32);
	const prk = await hmac(Uint8Array.from(salt), Uint8Array.from(ikm));
	const cek = await hkdf_expand(prk, Uint8Array.from(new TextEncoder().encode("Content-Encoding: aes128gcm\0")), 16);
	const nonce = await hkdf_expand(prk, Uint8Array.from(new TextEncoder().encode("Content-Encoding: nonce\0")), 12);
	const plaintext = new TextEncoder().encode(JSON.stringify(payload));
	// The advertised record size limits the payload plus its one-byte padding
	// delimiter; the salt/key header and AEAD tag are outside that limit.
	if (plaintext.length + 1 > 4096) throw new Error("Web Push payload is too large.");
	const padded = new Uint8Array(plaintext.length + 1);
	padded.set(plaintext);
	padded[plaintext.length] = 2;
	const aes_key = await crypto.subtle.importKey("raw", as_array_buffer(cek), "AES-GCM", false, ["encrypt"]);
	const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: as_array_buffer(nonce) }, aes_key, as_array_buffer(padded)));
	const body = new Uint8Array(21 + ephemeral_public_key.length + encrypted.length);
	body.set(salt, 0);
	new DataView(body.buffer).setUint32(16, 4096);
	new DataView(body.buffer).setUint8(20, ephemeral_public_key.length);
	body.set(ephemeral_public_key, 21);
	body.set(encrypted, 21 + ephemeral_public_key.length);
	return body;
}

export async function send_web_push(subscription: Web_push_subscription, payload: Web_push_payload): Promise<void> {
	if (!valid_subscription(subscription) || !valid_payload(payload)) throw new Error("Invalid Web Push payload.");
	const config = get_web_push_config();
	if (!config) throw new Error("Web Push is not configured.");
	const key_pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
	const ephemeral_public_key = new Uint8Array(await crypto.subtle.exportKey("raw", key_pair.publicKey));
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const body = await encrypt_web_push_payload(subscription, payload, salt, key_pair.privateKey, ephemeral_public_key);
	const authorization = await create_vapid_authorization(subscription.endpoint, config);
	const response = await fetch(subscription.endpoint, {
		method: "POST",
		headers: { Authorization: authorization, TTL: "86400", "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream" },
		body,
	});
	if (response.status === 404 || response.status === 410) {
		await remove_web_push_endpoint(subscription.endpoint);
		return;
	}
	if (!response.ok) throw new Error(`Web Push service returned HTTP ${response.status}.`);
}

export function web_push_subscription_from_job(payload: Record<string, any>): Web_push_subscription {
	return { endpoint: payload.endpoint, keys: { p256dh: payload.p256dh, auth: payload.auth } };
}
