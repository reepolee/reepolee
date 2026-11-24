import { describe, expect, test } from "bun:test";
import type { BunRequest } from "bun";

import { extract_register_params } from "./index";

const req_for = (path: string) => ({ url: `http://localhost${path}` }) as unknown as BunRequest;

describe("extract_register_params - malformed percent-encoding", () => {
	test("extracts username and invitation code from a well-formed URL", () => {
		const params = extract_register_params(req_for("/register/jane/0190c9f2-0000-7000-8000-000000000000"));
		expect(params.username).toBe("jane");
		expect(params.invitation_code).toBe("0190c9f2-0000-7000-8000-000000000000");
	});

	test("lowercases the username", () => {
		const params = extract_register_params(req_for("/register/Jane/inv"));
		expect(params.username).toBe("jane");
	});

	test("decodes percent-encoded segments", () => {
		const params = extract_register_params(req_for("/register/ja%20ne/inv%20code"));
		expect(params.username).toBe("ja ne");
		expect(params.invitation_code).toBe("inv code");
	});

	test("malformed escape in the username decodes to empty instead of throwing", () => {
		// decodeURIComponent("%zz") throws URIError; the handler must not 500/hang.
		const params = extract_register_params(req_for("/register/%zz/inv"));
		expect(params.username).toBe("");
		expect(params.invitation_code).toBe("inv");
	});

	test("malformed escape in the invitation code decodes to empty instead of throwing", () => {
		const params = extract_register_params(req_for("/register/jane/%zz"));
		expect(params.username).toBe("jane");
		expect(params.invitation_code).toBe("");
	});
});
