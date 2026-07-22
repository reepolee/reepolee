////////////////////////////////////////
// HELPERS (SAME SCOPE, NO GLOBALS)
////////////////////////////////////////

async function post_json(url, body) {
	if (!url) throw new Error("post_json: missing url");

	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});

	const data = await res.json().catch(() => null);
	return [res.status, data];
}

async function form_validate_field(form, field) {
	if (!form || !field) return;

	try {
		const [, data] = await post_json(form.validate_url, {
			...form.values,
			touched: [field],
		});

		if (!form.errors) form.errors = {};
		form.errors[field] = data?.errors?.[field] || "";
	} catch  {}
}

async function form_mark_touched(form, field) {
	if (!form || !field) return;

	if (!form.touched) form.touched = [];

	if (!form.touched.includes(field)) {
		form.touched.push(field);
	}

	await form_validate_field(form, field);
}

async function form_submit(form) {
	if (!form?.validate_url) return;

	try {
		const [, data] = await post_json(form.validate_url, {
			...form.values,
			touched: form._get_fields(),
		});

		if (!data?.success) {
			form.errors = {
				...form.errors,
				...data?.errors,
			};
			return;
		}

		form._submitted = true;
		form.form_element.submit();
	} catch  {}
}

////////////////////////////////////////
// FORM CONTROLLER
////////////////////////////////////////

// eslint-disable-next-line no-unused-vars
class FormController {
	constructor(options = {}) {
		// -------------------------
		// DOM
		// -------------------------
		this.form_element = $(options.form || "#edit-form");

		// -------------------------
		// config
		// -------------------------
		this.validate_url = options.validate_url || "/validate";
		this.submitted_text = options.submitted_text || "Sending...";

		this.errors = options.errors || {};
		this.touched = [];
		this._submitted = false;

		// cache initial values
		this.values = this._read_initial_values();

		// -------------------------
		// submit buttons
		// -------------------------
		this._submit_buttons = this._get_submit_buttons();
		this._original_button_texts = this._submit_buttons.map((btn) => btn.textContent);

		// -------------------------
		// init
		// -------------------------
		this._bind_events();
		this.render_errors();
	}

	////////////////////////////////////////
	// FIELD SYSTEM (DOM = SOURCE OF TRUTH)
	////////////////////////////////////////

	_get_fields() {
		return this._inputs()
			.map((el) => el.name)
			.filter(Boolean);
	}

	_inputs() {
		return $$("input[name], textarea[name], select[name]", this.form_element);
	}

	_get_submit_buttons() {
		return $$("button[type='submit'], input[type='submit']", this.form_element);
	}

	////////////////////////////////////////
	// INIT HELPERS
	////////////////////////////////////////

	_read_initial_values() {
		const values = {};

		this._inputs().forEach((el) => {
			if (!el.name) return;
			values[el.name] = el.value;
		});

		return values;
	}

	////////////////////////////////////////
	// EVENTS
	////////////////////////////////////////

	_bind_events() {
		if (!this.form_element) return;

		// input sync
		this._inputs().forEach((el) => {
			el.addEventListener("input", (e) => {
				if (!e.target?.name) return;
				this.values[e.target.name] = e.target.value;
			});
		});

		// blur validation (input/select/textarea safe)
		this.form_element.addEventListener("focusout", async (e) => {
			const el = e.target;

			if (!el?.name) return;
			if (!("value" in el)) return;

			await form_mark_touched(this, el.name);
			this.render_errors();
		});

		// submit
		this.form_element.addEventListener("submit", async (e) => {
			e.preventDefault();
			if (this._submitted) return;

			this._set_submitting(true);
			this.render_errors();

			await form_submit(this);

			// Only restore if validation failed (form wasn't actually submitted)
			if (!this._submitted) {
				this._set_submitting(false);
				this.render_errors();
			}
		});
	}

	////////////////////////////////////////
	// API
	////////////////////////////////////////

	set_field(name, value) {
		this.values[name] = value;
	}

	get_field(name) {
		return this.values[name];
	}

	has_errors() {
		return Object.values(this.errors).some(Boolean);
	}

	////////////////////////////////////////
	// RENDER
	////////////////////////////////////////

	_set_submitting(isSubmitting) {
		this._submit_buttons.forEach((btn, i) => {
			btn.disabled = isSubmitting;
			btn.textContent = isSubmitting ? this.submitted_text : this._original_button_texts[i];
		});
	}

	render_errors() {
		for (const field of this._get_fields()) {
			const el = $(`#error-${field}`);
			if (!el) continue;

			el.innerHTML = this.errors[field] || "";
		}
	}
}
