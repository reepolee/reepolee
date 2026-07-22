// smtp.ts – Bun native email sender with HTML support, CC, and BCC

import * as net from "node:net";
import * as tls from "node:tls";

import { require_env } from "$lib/env";
import { now_epoch_ms, now_iso_str } from "$lib/temporal";

export interface SendMailOptions {
	to: string | string[];
	cc?: string | string[];
	bcc?: string | string[];
	subject: string;
	body: string;
	html?: string;
	tls?: { rejectUnauthorized?: boolean; };
}

export async function send_mail(param_options: SendMailOptions): Promise<void> {
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

	const CRLF = "\r\n";
	const isImplicitTls = options.port === 465;

	console.log(`[SMTP] Connecting to ${options.host}:${options.port}`);

	// Helper to normalize email addresses to array
	const normalizeEmails = (emails: string | string[] | undefined): string[] => {
		if (!emails) return [];
		if (Array.isArray(emails)) return emails;
		return emails.split(",").map((email) => email.trim());
	};

	// Helper to format email headers (multiple recipients)
	const formatEmailHeader = (emails: string | string[] | undefined): string => {
		if (!emails) return "";
		const emailArray = normalizeEmails(emails);
		return emailArray.join(", ");
	};

	// Helper to read SMTP response with timeout
	const readResponse = (socket: net.Socket | tls.TLSSocket, timeoutMs = 30000): Promise<{ code: number; message: string; }> => {
		return new Promise(
			(resolve, reject) => {
				let buffer = "";
				const timeout = setTimeout(() => {
					cleanup();
					reject(new Error(`Timeout waiting for SMTP response after ${timeoutMs}ms`));
				}, timeoutMs);

				const onData = (data: Buffer) => {
					buffer += data.toString();
					const lines = buffer.split(CRLF);
					for (const line of lines) {
						if (line.length >= 4 && /^\d{3} /.test(line)) {
							const code = parseInt(line.slice(0, 3), 10);
							const message = line.slice(4);
							cleanup();
							resolve({ code, message });
							return;
						}
					}
				};

				const onError = (err: Error) => {
					cleanup();
					reject(err);
				};

				const cleanup = () => {
					clearTimeout(timeout);
					socket.removeListener("data", onData);
					socket.removeListener("error", onError);
				};

				socket.on("data", onData);
				socket.on("error", onError);
			},
		);
	};

	// Helper to send command and expect response
	const sendCommand = async (socket: net.Socket | tls.TLSSocket, command: string, expectedCode?: number): Promise<{ code: number; message: string; }> => {
		console.log(`[SMTP] Sending: ${command}`);
		socket.write(command + CRLF);
		const response = await readResponse(socket);
		if (expectedCode !== undefined && response.code !== expectedCode) { throw new Error(`Expected ${expectedCode} but got ${response.code}: ${response.message}`); }
		console.log(`[SMTP] Response: ${response.code} ${response.message}`);
		return response;
	};

	// Generate boundary for multipart messages
	const generateBoundary = (): string => { return `----=_Part_${now_epoch_ms()}_${Math.random().toString(36).substring(2)}`; };

	// Build email content (supports plain text, HTML, or both)
	const buildEmailContent = (): string => {
		const date = now_iso_str();
		const messageId = `<${now_epoch_ms()}.${Math.random().toString(36).slice(2)}@${options.host}>`;

		// Basic headers
		const headers = [
			`From: ${options.from}`,
			`To: ${formatEmailHeader(options.to)}`,
			`Subject: ${options.subject}`,
			`Date: ${date}`,
			`Message-ID: ${messageId}`,
			"MIME-Version: 1.0",
		];

		// Add CC header if present
		if (options.cc) { headers.push(`Cc: ${formatEmailHeader(options.cc)}`); }

		// Note: BCC is not included in the email headers (that's the point of BCC)

		let body = "";

		// Check if we have HTML content
		if (options.html && options.body) {
			// Multipart/alternative (both plain text and HTML)
			const boundary = generateBoundary();
			headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);

			body = [
				`--${boundary}`,
				"Content-Type: text/plain; charset=utf-8",
				"Content-Transfer-Encoding: 7bit",
				"",
				options.body,
				"",
				`--${boundary}`,
				"Content-Type: text/html; charset=utf-8",
				"Content-Transfer-Encoding: 7bit",
				"",
				options.html,
				"",
				`--${boundary}--`,
			].join(CRLF);
		} else if (options.html) {
			// HTML only
			headers.push("Content-Type: text/html; charset=utf-8");
			headers.push("Content-Transfer-Encoding: 7bit");
			body = options.html;
		} else {
			// Plain text only
			headers.push("Content-Type: text/plain; charset=utf-8");
			headers.push("Content-Transfer-Encoding: 7bit");
			body = options.body;
		}

		return headers.join(CRLF) + CRLF + CRLF + body;
	};

	let socket: net.Socket | tls.TLSSocket;

	try {
		// Connect with plain TCP first
		socket = net.connect({ host: options.host, port: options.port });

		// Wait for connection
		await new Promise((resolve, reject) => {
			socket.once("connect", resolve);
			socket.once("error", reject);
			setTimeout(() => reject(new Error("Connection timeout")), 10000);
		});

		console.log(`[SMTP] TCP connection established`);

		// Read greeting
		const response = await readResponse(socket);
		if (response.code !== 220) { throw new Error(`Invalid greeting: ${response.code} ${response.message}`); }
		console.log(`[SMTP] Greeting OK`);

		// Send EHLO
		let usingEhlo = true;
		try {
			await sendCommand(socket, "EHLO bun", 250);
			console.log(`[SMTP] EHLO successful`);
		} catch {
			console.log(`[SMTP] EHLO failed, trying HELO...`);
			usingEhlo = false;
			await sendCommand(socket, "HELO bun", 250);
			console.log(`[SMTP] HELO successful`);
		}

		// STARTTLS if not implicit TLS
		if (!isImplicitTls && usingEhlo) {
			try {
				console.log(`[SMTP] Attempting STARTTLS...`);
				await sendCommand(socket, "STARTTLS", 220);
				console.log(`[SMTP] STARTTLS accepted, upgrading to TLS...`);

				// Upgrade to TLS
				const tlsSocket = tls.connect({
					socket: socket,
					host: options.host,
					rejectUnauthorized: options.tls?.rejectUnauthorized ?? false,
				});

				// Wait for TLS handshake
				await new Promise((resolve, reject) => {
					tlsSocket.once("secureConnect", resolve);
					tlsSocket.once("error", reject);
					setTimeout(() => reject(new Error("TLS handshake timeout")), 10000);
				});

				socket = tlsSocket;
				console.log(`[SMTP] TLS upgrade complete`);

				// Re-send EHLO after TLS
				await sendCommand(socket, "EHLO bun", 250);
				console.log(`[SMTP] EHLO after TLS successful`);
			} catch (err) {
				console.log(`[SMTP] STARTTLS failed:`, err);
				throw new Error(`STARTTLS required but failed: ${err}`);
			}
		}

		// Authenticate
		if (options.username && options.password) {
			console.log(`[SMTP] Authenticating...`);
			await sendCommand(socket, "AUTH LOGIN", 334);
			await sendCommand(socket, Buffer.from(options.username).toString("base64"), 334);
			await sendCommand(socket, Buffer.from(options.password).toString("base64"), 235);
			console.log(`[SMTP] Authentication successful`);
		}

		// Send MAIL FROM
		await sendCommand(socket, `MAIL FROM:<${options.from}>`, 250);
		console.log(`[SMTP] Sender accepted`);

		// Send RCPT TO for main recipients
		const toRecipients = normalizeEmails(options.to);
		for (const recipient of toRecipients) {
			await sendCommand(socket, `RCPT TO:<${recipient}>`, 250);
			console.log(`[SMTP] Recipient (to) accepted: ${recipient}`);
		}

		// Send RCPT TO for CC recipients
		if (options.cc) {
			const ccRecipients = normalizeEmails(options.cc);
			for (const recipient of ccRecipients) {
				await sendCommand(socket, `RCPT TO:<${recipient}>`, 250);
				console.log(`[SMTP] Recipient (cc) accepted: ${recipient}`);
			}
		}

		// Send RCPT TO for BCC recipients (these won't appear in headers)
		if (options.bcc) {
			const bccRecipients = normalizeEmails(options.bcc);
			for (const recipient of bccRecipients) {
				await sendCommand(socket, `RCPT TO:<${recipient}>`, 250);
				console.log(`[SMTP] Recipient (bcc) accepted: ${recipient}`);
			}
		}

		// Send DATA
		await sendCommand(socket, "DATA", 354);
		console.log(`[SMTP] Ready to send message`);

		// Build and send email
		const emailContent = buildEmailContent();
		const message = `${emailContent + CRLF}.${CRLF}`;

		console.log(`[SMTP] Sending email (${message.length} bytes)`);
		socket.write(message);

		// Wait for acceptance
		const dataResponse = await readResponse(socket);
		if (dataResponse.code !== 250) { throw new Error(`Message rejected: ${dataResponse.message}`); }
		console.log(`[SMTP] Message accepted by server`);

		// Send QUIT
		await sendCommand(socket, "QUIT", 221);
		console.log(`[SMTP] Connection closed gracefully`);

		console.log(`[SMTP] ✅ Email sent successfully!`);
		console.log(
			`[SMTP] Summary: To: ${toRecipients.length}, CC: ${options.cc ? normalizeEmails(options.cc).length : 0}, BCC: ${options.bcc ? normalizeEmails(options.bcc).length : 0}`
		);
	} catch (error) {
		console.error(`[SMTP] ❌ Failed:`, error);
		throw error;
	} finally {
		if (socket && !socket.destroyed) { socket.end(); }
	}
}
