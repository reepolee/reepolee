import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tls from "node:tls";

import { build_body_part, dot_stuff, encode_header_value, needs_transfer_encoding, rfc5322_date, send_mail, to_base64_body } from "./smtp";

const CRLF = "\r\n";

describe("smtp - dot_stuff", () => {
	test("escapes a line consisting of a single dot", () => {
		expect(dot_stuff(`before${CRLF}.${CRLF}after`)).toBe(`before${CRLF}..${CRLF}after`);
	});

	test("escapes a line that merely starts with a dot", () => {
		expect(dot_stuff(`.hidden config${CRLF}next`)).toBe(`..hidden config${CRLF}next`);
	});

	test("escapes a leading dot on the first line", () => {
		expect(dot_stuff(".gitignore")).toBe("..gitignore");
	});

	test("leaves dots that are not line-leading alone", () => {
		expect(dot_stuff(`see file.txt${CRLF}end.`)).toBe(`see file.txt${CRLF}end.`);
	});

	test("normalizes bare LF and CR to CRLF before stuffing", () => {
		expect(dot_stuff("a\n.b\rc")).toBe(`a${CRLF}..b${CRLF}c`);
	});

	test("stuffs every offending line, not just the first", () => {
		expect(dot_stuff(`.a${CRLF}.b${CRLF}.c`)).toBe(`..a${CRLF}..b${CRLF}..c`);
	});

	test("leaves content without leading dots unchanged", () => {
		const body = `Hello,${CRLF}${CRLF}Regards.${CRLF}`;
		expect(dot_stuff(body)).toBe(body);
	});

	test("handles empty content", () => {
		expect(dot_stuff("")).toBe("");
	});

	test("the terminator appended after stuffing is the only bare dot line", () => {
		// Mirrors the DATA payload send_mail() writes: dot_stuff(content) + CRLF + "." + CRLF.
		const content = `Subject: t${CRLF}${CRLF}.${CRLF}body`;
		const message = `${dot_stuff(content) + CRLF}.${CRLF}`;
		const bare_dot_lines = message.split(CRLF).filter((line) => line === ".");
		expect(bare_dot_lines).toHaveLength(1);
		expect(message.endsWith(`${CRLF}.${CRLF}`)).toBe(true);
	});
});

describe("smtp - needs_transfer_encoding", () => {
	test("plain ASCII in short lines stays 7bit", () => {
		expect(needs_transfer_encoding(`Hello,${CRLF}Regards`)).toBe(false);
	});

	test("non-ASCII requires encoding", () => {
		expect(needs_transfer_encoding("Dober dan, Aleš")).toBe(true);
	});

	test("emoji (astral plane) requires encoding", () => {
		expect(needs_transfer_encoding("ship it 🚀")).toBe(true);
	});

	test("a line over 998 chars requires encoding even in pure ASCII", () => {
		expect(needs_transfer_encoding("a".repeat(999))).toBe(true);
		expect(needs_transfer_encoding("a".repeat(998))).toBe(false);
	});

	test("long total length split across short lines stays 7bit", () => {
		const content = Array.from({ length: 50 }, () => "a".repeat(100)).join(CRLF);
		expect(needs_transfer_encoding(content)).toBe(false);
	});

	test("measures lines split on bare LF, not just CRLF", () => {
		expect(needs_transfer_encoding(`short\n${"a".repeat(999)}`)).toBe(true);
	});
});

describe("smtp - to_base64_body", () => {
	test("round-trips UTF-8 content", () => {
		const original = "Dober dan, Aleš 🚀";
		const decoded = Buffer.from(to_base64_body(original).replaceAll(CRLF, ""), "base64").toString("utf8");
		expect(decoded).toBe(original);
	});

	test("wraps at 76 characters", () => {
		const lines = to_base64_body("x".repeat(500)).split(CRLF);
		expect(lines.length).toBeGreaterThan(1);
		for (const line of lines) { expect(line.length).toBeLessThanOrEqual(76); }
	});

	test("output never contains a line-leading dot to stuff", () => {
		expect(to_base64_body("š".repeat(200)).includes(".")).toBe(false);
	});
});

describe("smtp - encode_header_value", () => {
	test("leaves pure ASCII untouched", () => {
		expect(encode_header_value("Password reset")).toBe("Password reset");
	});

	test("encodes non-ASCII as an RFC 2047 encoded-word", () => {
		const encoded = encode_header_value("Ponastavitev gesla — Aleš");
		expect(encoded.startsWith("=?UTF-8?B?")).toBe(true);
		expect(encoded.endsWith("?=")).toBe(true);
		const payload = encoded.slice("=?UTF-8?B?".length, -"?=".length);
		expect(Buffer.from(payload, "base64").toString("utf8")).toBe("Ponastavitev gesla — Aleš");
	});

	test("splits long values into folded words, each within 75 chars", () => {
		const subject = `Zelo dolga zadeva s šumniki ${"č".repeat(80)}`;
		const encoded = encode_header_value(subject);
		const words = encoded.split(`${CRLF} `);
		expect(words.length).toBeGreaterThan(1);
		for (const word of words) { expect(word.length).toBeLessThanOrEqual(75); }
	});

	test("each word decodes to valid UTF-8 on its own (no split mid-character)", () => {
		const subject = "🚀".repeat(40);
		const words = encode_header_value(subject).split(`${CRLF} `);
		const rejoined = words
			.map((word) => Buffer.from(word.slice("=?UTF-8?B?".length, -"?=".length), "base64").toString("utf8"))
			.join("");
		expect(rejoined).toBe(subject);
		for (const word of words) {
			const decoded = Buffer.from(word.slice("=?UTF-8?B?".length, -"?=".length), "base64").toString("utf8");
			expect(decoded.includes("�")).toBe(false);
		}
	});
});

describe("smtp - build_body_part", () => {
	test("declares 7bit and passes content through when it is safe", () => {
		const part = build_body_part("Hello", "text/plain");
		expect(part.headers).toEqual(["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 7bit"]);
		expect(part.body).toBe("Hello");
	});

	test("declares base64 and encodes when content is non-ASCII", () => {
		const part = build_body_part("<p>Aleš</p>", "text/html");
		expect(part.headers).toEqual(["Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: base64"]);
		expect(part.body).not.toContain("Aleš");
		expect(Buffer.from(part.body.replaceAll(CRLF, ""), "base64").toString("utf8")).toBe("<p>Aleš</p>");
	});

	test("never declares 7bit for content that is not 7-bit clean", () => {
		for (const content of ["Aleš", "🚀", "a".repeat(1500)]) {
			expect(build_body_part(content, "text/plain").headers).toContain("Content-Transfer-Encoding: base64");
		}
	});
});

describe("smtp - rfc5322_date", () => {
	test("formats as an RFC 5322 date-time in UTC", () => {
		expect(rfc5322_date(new Date(Date.UTC(2026, 7, 16, 9, 24, 31)))).toBe("Sun, 16 Aug 2026 09:24:31 +0000");
	});

	test("zero-pads the time but not the day", () => {
		expect(rfc5322_date(new Date(Date.UTC(2026, 0, 5, 4, 3, 2)))).toBe("Mon, 5 Jan 2026 04:03:02 +0000");
	});

	test("is not ISO 8601", () => {
		expect(rfc5322_date(new Date(Date.UTC(2026, 7, 16)))).not.toContain("T");
	});
});

// ---------------------------------------------------------------------------
// Transport integration - a scripted fake SMTP server on loopback
// ---------------------------------------------------------------------------

/**
 * A throwaway self-signed certificate for the fake server, generated into a
 * temp dir on first use and thrown away with the process.
 *
 * Deliberately not a fixture in the repo: committing a private key - even a
 * worthless one - trains people to ignore key material in diffs and trips
 * secret scanners. The cost is a dependency on `openssl` being present, so the
 * TLS tests skip rather than fail where it is not.
 */
let tls_credentials: { key: string; cert: string; } | null | undefined;

function test_tls_credentials(): { key: string; cert: string; } | null {
	if (tls_credentials !== undefined) return tls_credentials;

	const dir = mkdtempSync(join(tmpdir(), "smtp-tls-test-"));
	const key_path = join(dir, "key.pem");
	const cert_path = join(dir, "cert.pem");

	let result: ReturnType<typeof Bun.spawnSync>;
	try {
		result = Bun.spawnSync([
			"openssl",
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-keyout",
			key_path,
			"-out",
			cert_path,
			"-days",
			"1",
			"-nodes",
			"-subj",
			"/CN=127.0.0.1",
			"-addext",
			"subjectAltName=IP:127.0.0.1",
		], { stdout: "ignore", stderr: "ignore" });
	} catch {
		tls_credentials = null;
		rmSync(dir, { recursive: true, force: true });
		return tls_credentials;
	}

	tls_credentials = result.success
		? { key: readFileSync(key_path, "utf8"), cert: readFileSync(cert_path, "utf8") }
		: null;

	rmSync(dir, { recursive: true, force: true });
	return tls_credentials;
}

const tls_available = test_tls_credentials() !== null;
const tls_test = tls_available ? test : test.skip;

type FakeSession = {
	commands: string[];
	data: string;
	/** Commands seen before the TLS handshake. Must never include AUTH. */
	plaintext_commands: string[];
	/** True once this session actually completed a server-side handshake. */
	encrypted: boolean;
};

type FakeOptions = {
	/** Reply 220 to STARTTLS and perform a real server-side handshake. */
	starttls?: boolean;
	/** Serve TLS from the first byte, the way port 465 does. */
	implicit_tls?: boolean;
	/**
	 * Write the greeting and the EHLO reply in a single write, so both land in
	 * one TCP segment before EHLO is even sent. Exercises the requirement that
	 * bytes past the end of one reply survive for the next read.
	 */
	coalesce?: boolean;
};

const EHLO_REPLY = `250-fake.test${CRLF}250-SIZE 10240000${CRLF}250 HELP${CRLF}`;
const STARTTLS_EHLO_REPLY = `250-fake.test${CRLF}250-STARTTLS${CRLF}250 HELP${CRLF}`;

function start_fake_smtp(options: FakeOptions = {}) {
	const sessions: FakeSession[] = [];
	const creds = options.starttls || options.implicit_tls ? test_tls_credentials() : null;

	// One connection's SMTP state. Split out from the socket so a STARTTLS
	// upgrade can re-bind the same state to the TLSSocket that replaces it.
	// `greet` is separate from `session.encrypted`: an implicit-TLS connection is
	// encrypted from the first byte but still owes the client a 220 greeting,
	// while a STARTTLS upgrade re-enters this function mid-session and must not
	// greet again.
	const serve = (socket: net.Socket | tls.TLSSocket, session: FakeSession, greet: boolean) => {
		let in_data = false;
		let auth_step = 0;
		let buffer = "";

		const advertise = options.starttls && !session.encrypted ? STARTTLS_EHLO_REPLY : EHLO_REPLY;
		if (greet) { socket.write(options.coalesce ? `220 fake.test ESMTP${CRLF}${advertise}` : `220 fake.test ESMTP${CRLF}`); }

		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			for (;;) {
				const eol = buffer.indexOf(CRLF);
				if (eol === -1) break;
				const line = buffer.slice(0, eol);
				buffer = buffer.slice(eol + CRLF.length);

				if (in_data) {
					if (line === ".") {
						in_data = false;
						socket.write(`250 OK queued${CRLF}`);
					} else {
						session.data += line + CRLF;
					}
					continue;
				}

				session.commands.push(line);
				if (!session.encrypted) session.plaintext_commands.push(line);
				const upper = line.toUpperCase();

				if (upper.startsWith("EHLO")) {
					if (!options.coalesce) socket.write(options.starttls && !session.encrypted ? STARTTLS_EHLO_REPLY : EHLO_REPLY);
				} else if (upper.startsWith("HELO")) {
					socket.write(`250 fake.test${CRLF}`);
				} else if (upper === "STARTTLS") {
					if (!options.starttls || !creds) {
						socket.write(`502 not implemented${CRLF}`);
						continue;
					}
					socket.write(`220 ready${CRLF}`);
					// Hand the raw socket to a server-side TLSSocket and re-bind
					// this session to it. Anything still buffered here would be
					// pre-handshake plaintext, which RFC 3207 4.2 says to discard.
					socket.removeAllListeners("data");
					buffer = "";
					const secured = new tls.TLSSocket(socket as net.Socket, { isServer: true, key: creds.key, cert: creds.cert });
					secured.on("secure", () => {
						session.encrypted = true;
						serve(secured, session, false);
					});
					secured.on("error", () => {});
					return;
				} else if (upper === "AUTH LOGIN") {
					auth_step = 1;
					socket.write(`334 VXNlcm5hbWU6${CRLF}`);
				} else if (auth_step === 1) {
					auth_step = 2;
					socket.write(`334 UGFzc3dvcmQ6${CRLF}`);
				} else if (auth_step === 2) {
					auth_step = 0;
					socket.write(`235 authenticated${CRLF}`);
				} else if (upper.startsWith("MAIL FROM") || upper.startsWith("RCPT TO")) {
					socket.write(`250 OK${CRLF}`);
				} else if (upper === "DATA") {
					in_data = true;
					socket.write(`354 End data with <CRLF>.<CRLF>${CRLF}`);
				} else if (upper === "QUIT") {
					socket.write(`221 Bye${CRLF}`);
					socket.end();
				} else {
					socket.write(`500 unrecognized${CRLF}`);
				}
			}
		});

		socket.on("error", () => {});
	};

	const on_connection = (socket: net.Socket | tls.TLSSocket) => {
		const session: FakeSession = { commands: [], data: "", plaintext_commands: [], encrypted: !!options.implicit_tls };
		sessions.push(session);
		serve(socket, session, true);
	};

	const server = options.implicit_tls && creds
		? tls.createServer({ key: creds.key, cert: creds.cert }, on_connection)
		: net.createServer(on_connection);

	const ready = new Promise<number>((resolve) => {
		server.listen(0, "127.0.0.1", () => { resolve((server.address() as net.AddressInfo).port); });
	});

	return { server, sessions, ready };
}

async function with_fake_smtp<T>(options: FakeOptions, run: (sessions: FakeSession[], logs: string[]) => Promise<T>): Promise<T> {
	const fake = start_fake_smtp(options);
	const port = await fake.ready;

	const previous = { ...Bun.env };
	Bun.env.SMTP_ENABLED = "true";
	Bun.env.SMTP_HOST = "127.0.0.1";
	Bun.env.SMTP_PORT = String(port);
	Bun.env.SMTP_USERNAME = "postmaster";
	Bun.env.SMTP_PASSWORD = "hunter2-secret";
	Bun.env.SMTP_FROM = "noreply@fake.test";

	const logs: string[] = [];
	const real_log = console.log;
	const real_error = console.error;
	console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
	// send_mail logs the failure before rethrowing; the rejection tests assert
	// on the thrown error, so keep the expected noise out of the run.
	console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };

	try {
		return await run(fake.sessions, logs);
	} finally {
		console.log = real_log;
		console.error = real_error;
		for (const key of ["SMTP_ENABLED", "SMTP_HOST", "SMTP_PORT", "SMTP_USERNAME", "SMTP_PASSWORD", "SMTP_FROM"]) {
			if (previous[key] === undefined) delete Bun.env[key];
			else Bun.env[key] = previous[key];
		}
		fake.server.close();
	}
}

describe("smtp - send_mail transport", () => {
	test("throws the not-configured error when SMTP_ENABLED=false (documented off value)", async () => {
		const previous = Bun.env.SMTP_ENABLED;
		Bun.env.SMTP_ENABLED = "false";
		try {
			await expect(send_mail({ to: "ana@example.com", subject: "s", body: "b" }))
				.rejects.toThrow("SMTP is not configured");
		} finally {
			if (previous === undefined) delete Bun.env.SMTP_ENABLED;
			else Bun.env.SMTP_ENABLED = previous;
		}
	});

	test("completes a full session and writes a conformant message", async () => {
		await with_fake_smtp({}, async (sessions) => {
			await send_mail({
				to: ["ana@example.com", "bob@example.com"],
				cc: "carol@example.com",
				bcc: "auditor@example.com",
				subject: "Ponastavitev gesla — Aleš",
				body: `Pozdravljeni,${CRLF}.hidden line${CRLF}Lep pozdrav, Aleš`,
				tls: { allow_plaintext: true },
			});

			const session = sessions[0]!;
			const commands = session.commands;

			expect(commands[0]).toBe("EHLO bun");
			expect(commands).toContain("AUTH LOGIN");
			expect(commands).toContain("MAIL FROM:<noreply@fake.test>");
			expect(commands).toContain("RCPT TO:<ana@example.com>");
			expect(commands).toContain("RCPT TO:<bob@example.com>");
			expect(commands).toContain("RCPT TO:<carol@example.com>");
			// BCC is a recipient at the envelope level...
			expect(commands).toContain("RCPT TO:<auditor@example.com>");
			expect(commands).toContain("DATA");
			expect(commands).toContain("QUIT");

			// ...but never a header.
			expect(session.data).not.toContain("auditor@example.com");
			expect(session.data).toContain("To: ana@example.com, bob@example.com");
			expect(session.data).toContain("Cc: carol@example.com");

			// RFC 5322 Date, not ISO 8601.
			expect(session.data).toMatch(/Date: (Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{1,2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} \+0000/);

			// Non-ASCII subject arrives as an encoded-word.
			expect(session.data).toContain("Subject: =?UTF-8?B?");
			expect(session.data).not.toContain("Subject: Ponastavitev");

			// Non-ASCII body is base64, declared as such.
			expect(session.data).toContain("Content-Transfer-Encoding: base64");
			expect(session.data).not.toContain("Content-Transfer-Encoding: 7bit");
		});
	});

	test("dot-stuffs on the wire and the server recovers the original body", async () => {
		await with_fake_smtp({}, async (sessions) => {
			await send_mail({
				to: "ana@example.com",
				subject: "plain",
				body: `first${CRLF}.hidden${CRLF}.${CRLF}last`,
				tls: { allow_plaintext: true },
			});

			// ASCII body stays 7bit, so the raw lines are visible as received.
			// The fake server strips no dots, so the extra ones must be present.
			const session = sessions[0]!;
			expect(session.data).toContain(`..hidden${CRLF}`);
			expect(session.data).toContain(`..${CRLF}`);
			// The lone "." terminator ended DATA rather than truncating the body.
			expect(session.data).toContain("last");
		});
	});

	test("refuses to authenticate over an unencrypted connection by default", async () => {
		await with_fake_smtp({}, async (sessions) => {
			await expect(send_mail({ to: "ana@example.com", subject: "s", body: "b" }))
				.rejects.toThrow(/STARTTLS required but failed/);

			// The password never reached the wire.
			expect(sessions[0]!.commands).not.toContain("AUTH LOGIN");
		});
	});

	test("keeps AUTH payloads out of the log", async () => {
		await with_fake_smtp({}, async (_sessions, logs) => {
			await send_mail({ to: "ana@example.com", subject: "s", body: "b", tls: { allow_plaintext: true } });

			const joined = logs.join("\n");
			expect(joined).toContain("AUTH LOGIN");
			expect(joined).toContain("<redacted>");
			expect(joined).not.toContain(Buffer.from("hunter2-secret").toString("base64"));
			expect(joined).not.toContain(Buffer.from("postmaster").toString("base64"));
			expect(joined).not.toContain("hunter2-secret");
		});
	});

	test("survives a reply that arrives coalesced with the previous one", async () => {
		await with_fake_smtp({ coalesce: true }, async (sessions) => {
			await send_mail({ to: "ana@example.com", subject: "s", body: "b", tls: { allow_plaintext: true } });
			expect(sessions[0]!.commands).toContain("QUIT");
		});
	});
});

// ---------------------------------------------------------------------------
// TLS transport - the two paths the plaintext-only fake server could not reach
// ---------------------------------------------------------------------------

describe("smtp - TLS transport", () => {
	tls_test("implicit TLS (465-style) speaks SMTP only after the handshake", async () => {
		await with_fake_smtp({ implicit_tls: true }, async (sessions) => {
			await send_mail({
				to: "ana@example.com",
				subject: "s",
				body: "b",
				// The suite cannot bind port 465, so implicit mode is forced.
				tls: { implicit: true, rejectUnauthorized: false },
			});

			const session = sessions[0]!;
			expect(session.encrypted).toBe(true);
			// The whole session, greeting included, happened inside TLS.
			expect(session.plaintext_commands).toEqual([]);
			expect(session.commands).toContain("AUTH LOGIN");
			expect(session.commands).toContain("QUIT");
			// No STARTTLS - the connection was already encrypted.
			expect(session.commands).not.toContain("STARTTLS");
		});
	});

	tls_test("STARTTLS upgrades the live socket and re-sends EHLO", async () => {
		await with_fake_smtp({ starttls: true }, async (sessions) => {
			await send_mail({
				to: "ana@example.com",
				subject: "s",
				body: "b",
				tls: { rejectUnauthorized: false },
			});

			const session = sessions[0]!;
			expect(session.encrypted).toBe(true);
			expect(session.commands).toContain("STARTTLS");
			// EHLO twice: once in the clear, once after the upgrade.
			expect(session.commands.filter((c) => c === "EHLO bun")).toHaveLength(2);
			expect(session.commands).toContain("QUIT");
		});
	});

	tls_test("credentials are never sent before the STARTTLS upgrade", async () => {
		await with_fake_smtp({ starttls: true }, async (sessions, logs) => {
			await send_mail({
				to: "ana@example.com",
				subject: "s",
				body: "b",
				tls: { rejectUnauthorized: false },
			});

			// This is the property the upgrade exists for. Everything up to
			// STARTTLS was readable on the wire; AUTH must not be in it.
			const plaintext = sessions[0]!.plaintext_commands;
			expect(plaintext).toContain("EHLO bun");
			expect(plaintext).toContain("STARTTLS");
			expect(plaintext).not.toContain("AUTH LOGIN");
			expect(plaintext.join("\n")).not.toContain(Buffer.from("hunter2-secret").toString("base64"));
			expect(logs.join("\n")).not.toContain("hunter2-secret");
		});
	});

	tls_test("the message body crosses only after the upgrade", async () => {
		await with_fake_smtp({ starttls: true }, async (sessions) => {
			await send_mail({
				to: "ana@example.com",
				subject: "secret subject",
				body: "confidential body",
				tls: { rejectUnauthorized: false },
			});

			const session = sessions[0]!;
			expect(session.data).toContain("confidential body");
			expect(session.plaintext_commands.join("\n")).not.toContain("MAIL FROM");
			expect(session.plaintext_commands.join("\n")).not.toContain("DATA");
		});
	});

	tls_test("certificate verification is on by default, not cosmetic", async () => {
		// The fake server presents a self-signed certificate. Without an explicit
		// opt-out the client must refuse it - otherwise the STARTTLS upgrade
		// protects against nothing, since anyone on the path can present one too.
		await with_fake_smtp({ starttls: true }, async (sessions) => {
			await expect(send_mail({ to: "ana@example.com", subject: "s", body: "b" }))
				.rejects.toThrow(/STARTTLS required but failed/);

			expect(sessions[0]!.commands).not.toContain("AUTH LOGIN");
		});
	});

	tls_test("a rejected certificate on implicit TLS fails before any SMTP is spoken", async () => {
		await with_fake_smtp({ implicit_tls: true }, async (sessions) => {
			await expect(send_mail({ to: "ana@example.com", subject: "s", body: "b", tls: { implicit: true } }))
				.rejects.toThrow();

			// The handshake failed, so no session ever reached the command loop.
			expect(sessions[0]?.commands ?? []).toEqual([]);
		});
	});
});
