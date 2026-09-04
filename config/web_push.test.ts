import { describe, expect, test } from "bun:test";

import { get_web_push_config } from "./web_push";

const encode = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const decode = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, "base64url"));

async function vapid_env(): Promise<Record<string, string>> {
	const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
	const public_key = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
	const private_jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
	return {
		WEB_PUSH_PUBLIC_KEY: encode(public_key),
		WEB_PUSH_PRIVATE_KEY: encode(decode(private_jwk.d!)),
	};
}

describe("WEB_PUSH_SUBJECT validation", () => {
	test("accepts mailto: subjects", async () => {
		const env = { ...(await vapid_env()), WEB_PUSH_SUBJECT: "mailto:admin@example.com" };
		expect(get_web_push_config(env)?.subject).toBe("mailto:admin@example.com");
	});

	test("accepts https:// subjects", async () => {
		const env = { ...(await vapid_env()), WEB_PUSH_SUBJECT: "https://example.com" };
		expect(get_web_push_config(env)?.subject).toBe("https://example.com");
	});

	test("accepts http:// subjects on local hosts", async () => {
		for (const subject of ["http://localhost:2338", "http://127.0.0.1:2338", "http://[::1]:2338", "http://comet:2338"]) {
			const env = { ...(await vapid_env()), WEB_PUSH_SUBJECT: subject };
			expect(get_web_push_config(env)?.subject).toBe(subject);
		}
	});

	test("rejects http:// subjects on public hosts", async () => {
		const env = { ...(await vapid_env()), WEB_PUSH_SUBJECT: "http://example.com" };
		expect(() => get_web_push_config(env)).toThrow("WEB_PUSH_SUBJECT");
	});

	test("rejects subjects without a valid scheme", async () => {
		const env = { ...(await vapid_env()), WEB_PUSH_SUBJECT: "ftp://example.com" };
		expect(() => get_web_push_config(env)).toThrow("WEB_PUSH_SUBJECT");
	});
});
