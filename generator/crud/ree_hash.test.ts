import { expect, test } from "bun:test";

import { inspect_form_fields_hash_content, stamp_form_fields_hash } from "./ree_hash";

test("form field hash detects manual field-section changes", () => {
	const form = `<!-- GEN:FIELDS:START -->
\t<input-text name="title"></input-text>
<!-- GEN:FIELDS:END -->`;
	const stamped = stamp_form_fields_hash(form);

	expect(stamped).toMatch(/<!-- GEN:FIELDS:START:sha256:[a-f0-9]{64} -->/);
	expect(inspect_form_fields_hash_content(stamped)).toBe("clean");
	expect(inspect_form_fields_hash_content(stamped.replace("title", "name"))).toBe("modified");
});
