import { sanitize_env_value } from "$lib/env";

export type Web_push_config = {
	public_key: string;
	private_key: string;
	subject: string;
};

function decode_base64url(value: string): Uint8Array {
	const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
	const binary = atob(padded);
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/**
 * The VAPID `sub` claim must be a mailto: address or an https:// URL. Plain
 * http:// is accepted only for local development hosts - loopback addresses and
 * single-label hostnames (e.g. "comet") - where browsers and push providers
 * accept it. Public http:// hosts are almost always a typo and are rejected.
 */
function valid_web_push_subject(subject: string): boolean {
	if (subject.startsWith("mailto:") || subject.startsWith("https://")) return true;
	if (!subject.startsWith("http://")) return false;
	try {
		const hostname = new URL(subject).hostname.toLowerCase();
		if (hostname === "localhost" || hostname === "::1" || hostname === "[::1]") return true;
		if (hostname === "127.0.0.1" || hostname.startsWith("127.")) return true;
		return !hostname.includes(".");
	} catch {
		return false;
	}
}

/** Web Push is available only when all VAPID values are configured. */
export function get_web_push_config(env: Record<string, string | undefined> = Bun.env): Web_push_config | null {
	const public_key = env.WEB_PUSH_PUBLIC_KEY ? sanitize_env_value(env.WEB_PUSH_PUBLIC_KEY) : undefined;
	const private_key = env.WEB_PUSH_PRIVATE_KEY ? sanitize_env_value(env.WEB_PUSH_PRIVATE_KEY) : undefined;
	const subject = env.WEB_PUSH_SUBJECT ? sanitize_env_value(env.WEB_PUSH_SUBJECT) : undefined;
	if (!public_key || public_key === "N/A" || !private_key || private_key === "N/A" || !subject || subject === "N/A") return null;
	if (!valid_web_push_subject(subject)) {
		throw new Error("WEB_PUSH_SUBJECT must be a mailto:, https://, or local http:// URL.");
	}
	try {
		const public_bytes = decode_base64url(public_key);
		const private_bytes = decode_base64url(private_key);
		if (public_bytes.length !== 65 || public_bytes[0] !== 4 || private_bytes.length !== 32) throw new Error();
	} catch {
		throw new Error("WEB_PUSH_PUBLIC_KEY must be a base64url P-256 public key and WEB_PUSH_PRIVATE_KEY must be a base64url 32-byte private key.");
	}
	return { public_key, private_key, subject };
}

function base64url(value: ArrayBuffer | Uint8Array): string {
	const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64url_decode(value: string): Uint8Array {
	const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
	const binary = atob(padded);
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function utf8(value: string): Uint8Array { return new TextEncoder().encode(value); }

function vapid_jwk(config: Web_push_config): Record<string, string> {
	const public_key = base64url_decode(config.public_key);
	const private_key = base64url_decode(config.private_key);
	if (public_key.length !== 65 || public_key[0] !== 4 || private_key.length !== 32) {
		throw new Error("WEB_PUSH_PUBLIC_KEY must be a base64url P-256 public key and WEB_PUSH_PRIVATE_KEY must be a base64url 32-byte private key.");
	}
	return {
		kty: "EC",
		crv: "P-256",
		x: base64url(public_key.slice(1, 33)),
		y: base64url(public_key.slice(33, 65)),
		d: base64url(private_key),
	};
}

/** Create the short-lived VAPID Authorization header for one push endpoint. */
export async function create_vapid_authorization(endpoint: string, config: Web_push_config, now = Math.floor(Date.now() / 1000)): Promise<string> {
	const url = new URL(endpoint);
	const audience = `${url.protocol}//${url.host}`;
	const header = base64url(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
	const payload = base64url(utf8(JSON.stringify({ aud: audience, exp: now + 12 * 60 * 60, sub: config.subject })));
	const unsigned = `${header}.${payload}`;
	const key = await crypto.subtle.importKey("jwk", vapid_jwk(config), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
	const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, Uint8Array.from(utf8(unsigned)));
	return `vapid t=${unsigned}.${base64url(signature)}, k=${config.public_key}`;
}
