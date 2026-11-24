// smtp.ts – Bun native email sender with HTML support, CC, and BCC

import * as net from "node:net";
import * as tls from "node:tls";

import { env_switch_on } from "$config/env_vars";
import { require_env } from "$lib/env";
import { now_epoch_ms } from "$lib/temporal";

const CRLF = "\r\n";

/**
 * RFC 5321 §4.5.2 transparency ("dot-stuffing").
 *
 * The DATA payload is terminated by a line containing a single ".", so any
 * body line that legitimately starts with "." must be sent with a second "."
 * prepended - otherwise the server treats it as end-of-message and the rest
 * of the mail is interpreted as SMTP commands. The receiver strips the extra
 * dot, so the delivered content is unchanged.
 *
 * Line endings are normalized to CRLF first: a bare LF does not start a new
 * SMTP line, so stuffing has to be decided on the same line boundaries the
 * server will see.
 */
export function dot_stuff(content: string): string {
	return content
		.replace(/\r\n|\r|\n/g, CRLF)
		.split(CRLF)
		.map((line) => (line.startsWith(".") ? `.${line}` : line))
		.join(CRLF);
}

/**
 * Whether a body part can legally travel as `7bit`.
 *
 * `7bit` promises US-ASCII only, in lines of at most 998 characters
 * (RFC 5322 §2.1.1). Declaring it while sending UTF-8 is a lie the receiving
 * MTA is free to act on - 8-bit bytes may be stripped to 7 bits and long
 * lines wrapped at an arbitrary column, either of which corrupts the message.
 * Anything that fails these tests must be transfer-encoded instead.
 */
export function needs_transfer_encoding(content: string): boolean {
	if (/[^\x00-\x7F]/.test(content)) return true;
	return content.split(/\r\n|\r|\n/).some((line) => line.length > 998);
}

/** Base64-encode UTF-8 content, wrapped at the 76-character limit RFC 2045 §6.8 sets. */
export function to_base64_body(content: string): string {
	const encoded = Buffer.from(content, "utf8").toString("base64");
	const lines: string[] = [];
	for (let i = 0; i < encoded.length; i += 76) { lines.push(encoded.slice(i, i + 76)); }
	return lines.join(CRLF);
}

/**
 * Encode a header value as RFC 2047 encoded-words when it carries non-ASCII.
 *
 * Header fields are US-ASCII; a raw UTF-8 Subject renders as mojibake in any
 * client that takes the spec at its word. Encoded-words are capped at 75
 * characters each, so long values are split across several words joined by a
 * folded whitespace continuation. Splitting happens on code points, never
 * mid-character: each word must decode to valid UTF-8 on its own.
 */
export function encode_header_value(value: string): string {
	if (!/[^\x00-\x7F]/.test(value)) return value;

	// "=?UTF-8?B?" + "?=" costs 12 chars of the 75, leaving 63 for base64 -
	// which encodes at most 47 bytes, rounded down to a 45-byte (3-byte
	// aligned) chunk so no word carries base64 padding mid-value.
	const MAX_CHUNK_BYTES = 45;
	const chunks: string[] = [];
	let current = "";
	let current_bytes = 0;

	for (const char of value) {
		const char_bytes = Buffer.byteLength(char, "utf8");
		if (current_bytes + char_bytes > MAX_CHUNK_BYTES) {
			chunks.push(current);
			current = "";
			current_bytes = 0;
		}
		current += char;
		current_bytes += char_bytes;
	}
	if (current) chunks.push(current);

	return chunks
		.map((chunk) => `=?UTF-8?B?${Buffer.from(chunk, "utf8").toString("base64")}?=`)
		.join(`${CRLF} `);
}

/**
 * Build one MIME part's headers and body, picking the transfer encoding that
 * the content actually requires.
 */
export function build_body_part(content: string, mime_type: string): { headers: string[]; body: string; } {
	const encode = needs_transfer_encoding(content);
	return {
		headers: [`Content-Type: ${mime_type}; charset=utf-8`, `Content-Transfer-Encoding: ${encode ? "base64" : "7bit"}`],
		body: encode ? to_base64_body(content) : content,
	};
}

const CONNECT_TIMEOUT_MS = 10_000;
const RESPONSE_TIMEOUT_MS = 30_000;

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Format a `Date:` header per RFC 5322 §3.3 - "Tue, 16 Aug 2026 09:24:31 +0000".
 *
 * ISO 8601 is a different grammar and is not valid here; clients that parse
 * strictly show no date at all, and several spam filters score a malformed
 * Date. Always emitted in UTC so the offset needs no zone table.
 */
export function rfc5322_date(when: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	const day = DAYS[when.getUTCDay()];
	const month = MONTHS[when.getUTCMonth()];
	const time = `${pad(when.getUTCHours())}:${pad(when.getUTCMinutes())}:${pad(when.getUTCSeconds())}`;
	return `${day}, ${when.getUTCDate()} ${month} ${when.getUTCFullYear()} ${time} +0000`;
}

type SmtpResponse = { code: number; message: string; };

/**
 * Framing and I/O for one SMTP session.
 *
 * The listeners live for the whole session rather than being attached per
 * command. Attaching them per read loses any bytes that arrive between one
 * response resolving and the next read starting - a Node socket in flowing
 * mode drops data emitted while no `data` listener is registered - and leaves
 * windows in which an `error` event has no listener at all, which takes the
 * process down rather than failing the send. A session-long buffer also lets
 * a single TCP segment carrying two responses be parsed as two responses.
 */
function create_session(initial_socket: net.Socket | tls.TLSSocket, log: (message: string) => void) {
	let socket = initial_socket;
	let buffer = "";
	let fatal: Error | null = null;
	let waiting: { settle: (result: SmtpResponse) => void; fail: (error: Error) => void; } | null = null;

	/**
	 * Pull one complete response off the buffer.
	 *
	 * A reply ends at the first line shaped `NNN ` (space); `NNN-` marks a
	 * continuation. Everything up to and including that line is consumed and
	 * anything after it is left in place for the next read.
	 */
	const take_response = (): SmtpResponse | null => {
		let from = 0;
		for (;;) {
			const eol = buffer.indexOf(CRLF, from);
			if (eol === -1) return null;
			const line = buffer.slice(from, eol);
			if (/^\d{3} /.test(line)) {
				buffer = buffer.slice(eol + CRLF.length);
				return { code: parseInt(line.slice(0, 3), 10), message: line.slice(4) };
			}
			from = eol + CRLF.length;
		}
	};

	const on_data = (chunk: Buffer) => {
		buffer += chunk.toString("utf8");
		if (!waiting) return;
		const response = take_response();
		if (response) {
			const w = waiting;
			waiting = null;
			w.settle(response);
		}
	};

	const on_error = (error: Error) => {
		fatal = error;
		const w = waiting;
		waiting = null;
		w?.fail(error);
	};

	const on_close = () => {
		if (!waiting) return;
		const error = new Error("SMTP connection closed while awaiting a response");
		fatal = error;
		const w = waiting;
		waiting = null;
		w.fail(error);
	};

	const attach = (target: net.Socket | tls.TLSSocket) => {
		target.on("data", on_data);
		target.on("error", on_error);
		target.on("close", on_close);
	};

	const detach = (target: net.Socket | tls.TLSSocket) => {
		target.removeListener("data", on_data);
		target.removeListener("error", on_error);
		target.removeListener("close", on_close);
	};

	attach(socket);

	const read_response = (timeout_ms = RESPONSE_TIMEOUT_MS): Promise<SmtpResponse> => {
		return new Promise((resolve, reject) => {
			if (fatal) { reject(fatal); return; }
			const ready = take_response();
			if (ready) { resolve(ready); return; }

			const timer = setTimeout(() => {
				waiting = null;
				reject(new Error(`Timeout waiting for SMTP response after ${timeout_ms}ms`));
			}, timeout_ms);

			waiting = {
				settle: (result) => { clearTimeout(timer); resolve(result); },
				fail: (error) => { clearTimeout(timer); reject(error); },
			};
		});
	};

	return {
		get socket() { return socket; },

		read_response,

		/**
		 * Send one command and check its reply. `redact` keeps AUTH payloads -
		 * the base64 username and password lines - out of the log; base64 is
		 * encoding, not encryption, so logging it discloses the credential.
		 */
		send: async (command: string, expected_code?: number, redact = false): Promise<SmtpResponse> => {
			log(`Sending: ${redact ? "<redacted>" : command}`);
			socket.write(command + CRLF);
			const response = await read_response();
			if (expected_code !== undefined && response.code !== expected_code) {
				throw new Error(`Expected ${expected_code} but got ${response.code}: ${response.message}`);
			}
			log(`Response: ${response.code} ${response.message}`);
			return response;
		},

		write_payload: (payload: string) => { socket.write(payload); },

		/**
		 * Move the session onto a TLS socket after a 220 reply to STARTTLS.
		 *
		 * The plaintext buffer is discarded rather than carried across, as
		 * RFC 3207 §4.2 requires: anything a network attacker injected before
		 * the handshake would otherwise be replayed as though the authenticated
		 * server had sent it.
		 */
		upgrade: (tls_socket: tls.TLSSocket) => {
			detach(socket);
			buffer = "";
			socket = tls_socket;
			attach(socket);
		},

		close: () => {
			detach(socket);
			// A bare listener keeps a late teardown error (RST after QUIT) from
			// reaching the process as an unhandled 'error' event.
			socket.on("error", () => {});
			if (!socket.destroyed) socket.end();
		},
	};
}

/** Await a one-shot socket event, clearing the timeout timer on every exit path. */
function await_event(socket: net.Socket | tls.TLSSocket, event: string, timeout_ms: number, label: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const done = (fn: () => void) => {
			clearTimeout(timer);
			socket.removeListener(event, on_event);
			socket.removeListener("error", on_error);
			fn();
		};
		const on_event = () => done(resolve);
		const on_error = (error: Error) => done(() => reject(error));
		// Left uncleared, this timer holds the event loop open for its full
		// duration after a connection that already succeeded.
		const timer = setTimeout(() => done(() => reject(new Error(`${label} timed out after ${timeout_ms}ms`))), timeout_ms);
		socket.once(event, on_event);
		socket.once("error", on_error);
	});
}

export interface SendMailOptions {
	to: string | string[];
	cc?: string | string[];
	bcc?: string | string[];
	subject: string;
	body: string;
	html?: string;
	tls?: {
		rejectUnauthorized?: boolean;
		/**
		 * Permit AUTH and message transfer over an unencrypted connection.
		 * Off by default; only meaningful for a local dev mail catcher
		 * (Mailpit, MailHog) that speaks no TLS at all.
		 */
		allow_plaintext?: boolean;
		/**
		 * Force implicit TLS (handshake before any SMTP, as on port 465) on or
		 * off. Defaults to `port === 465`, which is the convention but not a
		 * rule - relays do offer implicit TLS on other ports, and the test suite
		 * cannot bind a privileged one.
		 */
		implicit?: boolean;
	};
}

export async function send_mail(param_options: SendMailOptions): Promise<void> {
	// SMTP_ENABLED is the switch; the detail fields below are validated together
	// as a group at boot (config/env_vars.ts - env_var_groups), so once the
	// switch is on they are guaranteed present here.
	if (!env_switch_on("SMTP_ENABLED")) {
		throw new Error("SMTP is not configured - set SMTP_ENABLED=true (and SMTP_HOST, SMTP_PORT, SMTP_USERNAME, SMTP_PASSWORD, SMTP_FROM) in .env to enable email delivery.");
	}

	const smtp_host = require_env("SMTP_HOST");
	const smtp_port = parseInt(require_env("SMTP_PORT"), 10);
	const smtp_user = require_env("SMTP_USERNAME");
	const smtp_pass = require_env("SMTP_PASSWORD");
	const smtp_from = require_env("SMTP_FROM");

	const smtp_vars = {
		host: smtp_host,
		port: smtp_port,
		username: smtp_user,
		password: smtp_pass,
		from: smtp_from,
	};

	const options = { ...smtp_vars, ...param_options };

	const is_implicit_tls = options.tls?.implicit ?? options.port === 465;

	console.log(`[SMTP] Connecting to ${options.host}:${options.port}`);

	// Helper to normalize email addresses to array
	const normalize_emails = (emails: string | string[] | undefined): string[] => {
		if (!emails) return [];
		if (Array.isArray(emails)) return emails;
		return emails.split(",").map((email) => email.trim());
	};

	// Helper to format email headers (multiple recipients)
	const format_email_header = (emails: string | string[] | undefined): string => {
		if (!emails) return "";
		const email_array = normalize_emails(emails);
		return email_array.join(", ");
	};

	const log = (message: string) => { console.log(`[SMTP] ${message}`); };

	// Generate boundary for multipart messages
	const generate_boundary = (): string => { return `----=_Part_${now_epoch_ms()}_${Math.random().toString(36).substring(2)}`; };

	// Build email content (supports plain text, HTML, or both)
	const build_email_content = (): string => {
		const date = rfc5322_date(new Date(now_epoch_ms()));
		const message_id = `<${now_epoch_ms()}.${Math.random().toString(36).slice(2)}@${options.host}>`;

		// Basic headers
		const headers = [
			`From: ${options.from}`,
			`To: ${format_email_header(options.to)}`,
			`Subject: ${encode_header_value(options.subject)}`,
			`Date: ${date}`,
			`Message-ID: ${message_id}`,
			"MIME-Version: 1.0",
		];

		// Add CC header if present
		if (options.cc) { headers.push(`Cc: ${format_email_header(options.cc)}`); }

		// Note: BCC is not included in the email headers (that's the point of BCC)

		let body = "";

		// Check if we have HTML content
		if (options.html && options.body) {
			// Multipart/alternative (both plain text and HTML). Each part
			// carries its own transfer encoding - a plain-ASCII text part can
			// still ride as 7bit next to a base64 HTML part.
			const boundary = generate_boundary();
			headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);

			const text_part = build_body_part(options.body, "text/plain");
			const html_part = build_body_part(options.html, "text/html");

			body = [
				`--${boundary}`,
				...text_part.headers,
				"",
				text_part.body,
				"",
				`--${boundary}`,
				...html_part.headers,
				"",
				html_part.body,
				"",
				`--${boundary}--`,
			].join(CRLF);
		} else if (options.html) {
			// HTML only
			const part = build_body_part(options.html, "text/html");
			headers.push(...part.headers);
			body = part.body;
		} else {
			// Plain text only
			const part = build_body_part(options.body, "text/plain");
			headers.push(...part.headers);
			body = part.body;
		}

		return headers.join(CRLF) + CRLF + CRLF + body;
	};

	const allow_plaintext = options.tls?.allow_plaintext ?? false;
	let session: ReturnType<typeof create_session> | undefined;
	// Held separately so a failure before the session exists (connect timeout,
	// rejected certificate) still tears the socket down instead of leaking it.
	let raw_socket: net.Socket | tls.TLSSocket | undefined;
	let encrypted = false;

	try {
		// Port 465 is implicit TLS: the handshake comes first, before any SMTP
		// is spoken. Connecting with plain TCP here and merely skipping
		// STARTTLS - as this did previously - leaves the whole session,
		// credentials included, in cleartext.
		if (is_implicit_tls) {
			const tls_socket = tls.connect({
				host: options.host,
				port: options.port,
				rejectUnauthorized: options.tls?.rejectUnauthorized ?? true,
			});
			raw_socket = tls_socket;
			await await_event(tls_socket, "secureConnect", CONNECT_TIMEOUT_MS, "TLS connection");
			session = create_session(tls_socket, log);
			encrypted = true;
			log("TLS connection established");
		} else {
			const tcp_socket = net.connect({ host: options.host, port: options.port });
			raw_socket = tcp_socket;
			await await_event(tcp_socket, "connect", CONNECT_TIMEOUT_MS, "TCP connection");
			session = create_session(tcp_socket, log);
			log("TCP connection established");
		}

		// Read greeting
		const greeting = await session.read_response();
		if (greeting.code !== 220) { throw new Error(`Invalid greeting: ${greeting.code} ${greeting.message}`); }
		log("Greeting OK");

		// Send EHLO
		let using_ehlo = true;
		try {
			await session.send("EHLO bun", 250);
			log("EHLO successful");
		} catch {
			log("EHLO failed, trying HELO...");
			using_ehlo = false;
			await session.send("HELO bun", 250);
			log("HELO successful");
		}

		// STARTTLS if not already encrypted. Gated on EHLO only because a
		// server that rejects EHLO cannot advertise the extension - it is not a
		// reason to proceed in the clear, which the plaintext guard below
		// enforces for both paths.
		if (!encrypted && using_ehlo) {
			try {
				log("Attempting STARTTLS...");
				await session.send("STARTTLS", 220);
				log("STARTTLS accepted, upgrading to TLS...");

				const tls_socket = tls.connect({
					socket: session.socket,
					host: options.host,
					// Verify the server certificate by default. Accepting any
					// certificate makes the STARTTLS upgrade cosmetic: an
					// attacker on the path can present their own and read the
					// AUTH LOGIN credentials that follow. Deployments against a
					// self-signed relay opt out explicitly via
					// `tls: { rejectUnauthorized: false }`.
					rejectUnauthorized: options.tls?.rejectUnauthorized ?? true,
				});
				await await_event(tls_socket, "secureConnect", CONNECT_TIMEOUT_MS, "TLS handshake");

				session.upgrade(tls_socket);
				encrypted = true;
				log("TLS upgrade complete");

				// Re-send EHLO after TLS
				await session.send("EHLO bun", 250);
				log("EHLO after TLS successful");
			} catch (err) {
				log(`STARTTLS failed: ${err}`);
				if (!allow_plaintext) { throw new Error(`STARTTLS required but failed: ${err}`); }
				log("Continuing without TLS (allow_plaintext)");
			}
		}

		// Nothing below this line may run in the clear unless the caller said
		// so: AUTH LOGIN discloses the password to anyone on the path, and the
		// message body follows it.
		if (!encrypted && !allow_plaintext) {
			throw new Error("Refusing to continue over an unencrypted connection - the server offered no usable TLS. Set tls.allow_plaintext to override.");
		}

		// Authenticate
		if (options.username && options.password) {
			log("Authenticating...");
			await session.send("AUTH LOGIN", 334);
			await session.send(Buffer.from(options.username).toString("base64"), 334, true);
			await session.send(Buffer.from(options.password).toString("base64"), 235, true);
			log("Authentication successful");
		}

		// Send MAIL FROM
		await session.send(`MAIL FROM:<${options.from}>`, 250);
		log("Sender accepted");

		// Send RCPT TO for main recipients
		const to_recipients = normalize_emails(options.to);
		for (const recipient of to_recipients) {
			await session.send(`RCPT TO:<${recipient}>`, 250);
			log(`Recipient (to) accepted: ${recipient}`);
		}

		// Send RCPT TO for CC recipients
		if (options.cc) {
			const cc_recipients = normalize_emails(options.cc);
			for (const recipient of cc_recipients) {
				await session.send(`RCPT TO:<${recipient}>`, 250);
				log(`Recipient (cc) accepted: ${recipient}`);
			}
		}

		// Send RCPT TO for BCC recipients (these won't appear in headers)
		if (options.bcc) {
			const bcc_recipients = normalize_emails(options.bcc);
			for (const recipient of bcc_recipients) {
				await session.send(`RCPT TO:<${recipient}>`, 250);
				log(`Recipient (bcc) accepted: ${recipient}`);
			}
		}

		// Send DATA
		await session.send("DATA", 354);
		log("Ready to send message");

		// Build and send email
		const email_content = build_email_content();
		const message = `${dot_stuff(email_content) + CRLF}.${CRLF}`;

		log(`Sending email (${Buffer.byteLength(message, "utf8")} bytes)`);
		session.write_payload(message);

		// Wait for acceptance
		const data_response = await session.read_response();
		if (data_response.code !== 250) { throw new Error(`Message rejected: ${data_response.message}`); }
		log("Message accepted by server");

		// Send QUIT
		await session.send("QUIT", 221);
		log("Connection closed gracefully");

		log("✅ Email sent successfully!");
		log(
			`Summary: To: ${to_recipients.length}, CC: ${options.cc ? normalize_emails(options.cc).length : 0}, BCC: ${options.bcc ? normalize_emails(options.bcc).length : 0}`
		);
	} catch (error) {
		console.error(`[SMTP] ❌ Failed:`, error);
		throw error;
	} finally {
		if (session) {
			session.close();
		} else if (raw_socket) {
			raw_socket.on("error", () => {});
			raw_socket.destroy();
		}
	}
}
