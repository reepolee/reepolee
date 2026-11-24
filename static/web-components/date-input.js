/**
 * date-input - form-participating masked date entry.
 *
 * Wraps a real <input type="hidden" name="..."> (light DOM, no shadow root)
 * so FormController's `input[name]` selector and validation-error wiring
 * keep working unchanged - same approach as markdown-editor.js.
 *
 * Renders a locale-formatted mask (e.g. "dd. mm. llll" for 'sl-si', underscores
 * as placeholders) built from Intl.DateTimeFormat.formatToParts, so segment
 * order and separators follow the locale attribute rather than being
 * hardcoded. Segment state is plain instance fields; typing digits fills the
 * focused segment, auto-advances, and renders synchronously. Validation
 * (required/min/max/calendar validity) runs on blur, matching the rest of
 * the form system.
 *
 * Exposes a `value` property/attribute (ISO "YYYY-MM-DD") and dispatches a
 * bubbling `input` event on change, like a native <input> - so page-level
 * deepSignal state can bind to it directly (see routes/examples/signals).
 */

const SEGMENT_LENGTHS = { year: 4, month: 2, day: 2 };
// Typing this many digits into the year segment auto-advances to the next
// field, like month/day - "26" is accepted as shorthand for 2026. Users can
// still type up to SEGMENT_LENGTHS.year digits for a full 4-digit year by
// navigating back into the segment and continuing.
const YEAR_SHORTHAND_LENGTH = 2;

class DateInput extends HTMLElement {
	static observedAttributes = ["value", "min", "max", "required", "disabled"];

	get value() {
		return this.hidden_input ? this.hidden_input.value : this.getAttribute("value") || "";
	}

	set value(next) {
		if (this._initialized) {
			// bind_state's watchEffect re-assigns .value on every "input" event,
			// including the ones this component itself dispatches on commit -
			// skip the no-op case so that echo doesn't reset segments mid-edit.
			if ((next || "") === this.hidden_input.value) return;
			this.values = segment_values_from_iso(next);
			this.render();
		} else {
			this.setAttribute("value", next || "");
		}
	}

	get locale() {
		return this.getAttribute("locale") || document.documentElement.lang || "en-US";
	}

	get min() {
		return this.getAttribute("min") || "";
	}

	get max() {
		return this.getAttribute("max") || "";
	}

	get required() {
		return this.hasAttribute("required");
	}

	get disabled() {
		return this.hasAttribute("disabled");
	}

	connectedCallback() {
		if (this._initialized) return;

		const name = this.getAttribute("name") || "";
		const initial_value = this.getAttribute("value") || "";

		this.hidden_input = document.createElement("input");
		this.hidden_input.type = "hidden";
		this.hidden_input.name = name;
		this.hidden_input.value = initial_value;

		this.display_el = document.createElement("div");
		this.display_el.className = "date-input-display";
		this.display_el.tabIndex = this.disabled ? -1 : 0;
		this.display_el.setAttribute("role", "textbox");
		this.display_el.setAttribute("aria-label", this.getAttribute("label") || name);

		this.append(this.hidden_input, this.display_el);

		this.segments = build_segments(this.locale);
		this.fields = this.segments.filter((segment) => segment.type !== "literal");

		this.values = segment_values_from_iso(initial_value);
		this.active = -1;

		this.bind_events();
		this.render();

		this._initialized = true;
	}

	attributeChangedCallback(name, old_value, new_value) {
		if (!this._initialized || old_value === new_value) return;

		if (name === "value") {
			this.values = segment_values_from_iso(new_value);
			this.render();
		} else if (name === "disabled") {
			this.display_el.tabIndex = this.disabled ? -1 : 0;
		}
	}

	bind_events() {
		this.display_el.addEventListener("click", (event) => {
			if (this.disabled) return;
			const segment_el = event.target.closest("[data-segment-index]");
			this.active = segment_el ? Number(segment_el.dataset.segmentIndex) : 0;
			this.render();
			this.display_el.focus();
		});

		this.display_el.addEventListener("focus", () => {
			if (this.active === -1) {
				this.active = 0;
				this.render();
			}
		});

		this.display_el.addEventListener("keydown", (event) => this.handle_keydown(event));

		this.display_el.addEventListener("paste", (event) => {
			if (this.disabled) return;
			event.preventDefault();
			this.paste_digits(event.clipboardData?.getData("text/plain") || "");
		});

		this.display_el.addEventListener("focusout", (event) => {
			if (this.contains(event.relatedTarget)) return;
			this.expand_short_year();
			this.active = -1;
			this.render();
			this.validate();
		});
	}

	// Purely visual - the public value (hidden_input) is only committed on
	// blur, once validate() confirms the typed date is complete and valid.
	// This keeps the previous committed value intact while the user is
	// mid-edit, instead of flickering the public/bound value on every keystroke.
	render() {
		render_segments(this.display_el, this.segments, this.values, this.active);
	}

	handle_keydown(event) {
		if (this.disabled) return;

		const active = this.active;
		if (active === -1) return;

		if (event.key === "ArrowLeft") {
			event.preventDefault();
			this.expand_short_year();
			this.active = Math.max(0, active - 1);
			this.render();
			return;
		}
		if (event.key === "ArrowRight") {
			event.preventDefault();
			this.expand_short_year();
			this.active = Math.min(this.fields.length - 1, active + 1);
			this.render();
			return;
		}
		if (event.key === "Backspace") {
			event.preventDefault();
			const segment_type = this.fields[active].type;
			const current = this.values[segment_type] || "";
			this.values = { ...this.values, [segment_type]: current.slice(0, -1) };
			this.render();
			return;
		}
		if (event.key === "Tab") return;

		if (/^[0-9]$/.test(event.key)) {
			event.preventDefault();
			this.type_digit(event.key);
		}
	}

	type_digit(digit) {
		const segment = this.fields[this.active];
		const max_length = SEGMENT_LENGTHS[segment.type];
		const current = this.values[segment.type] || "";
		const next = current.length >= max_length ? digit : current + digit;

		this.values = { ...this.values, [segment.type]: next };

		if (next.length >= max_length) {
			this.active = Math.min(this.fields.length - 1, this.active + 1);
		}

		this.render();
	}

	expand_short_year() {
		const year = this.values.year;
		if (year.length !== YEAR_SHORTHAND_LENGTH) return;

		const two_digit = parseInt(year, 10);
		const century = two_digit <= 68 ? 2000 : 1900;

		this.values = { ...this.values, year: String(century + two_digit) };
	}

	paste_digits(text) {
		const digits = text.replace(/\D/g, "");
		if (!digits.length) return;

		let cursor = this.active === -1 ? 0 : this.active;
		let remaining = digits;
		const values = { ...this.values };

		while (remaining.length && cursor < this.fields.length) {
			const segment = this.fields[cursor];
			const max_length = SEGMENT_LENGTHS[segment.type];
			values[segment.type] = remaining.slice(0, max_length);
			remaining = remaining.slice(max_length);
			cursor += 1;
		}

		this.values = values;
		this.active = Math.min(cursor, this.fields.length - 1);
		this.render();
	}

	validate() {
		const typed_iso = iso_from_segment_values(this.values);
		const all_empty = !this.values.year && !this.values.month && !this.values.day;
		const error_el = this.closest("field-wrapper")?.querySelector("validation-error") || this.parentElement?.querySelector("validation-error");

		let message = "";
		if (this.required && !typed_iso) {
			message = this.getAttribute("date_required") || "This field is required.";
		} else if (typed_iso && !is_valid_calendar_date(typed_iso)) {
			message = this.getAttribute("invalid_date") || "This date does not exist.";
		} else if (typed_iso && this.min && typed_iso < this.min) {
			const template = this.getAttribute("date_min") || "Date must be on or after {min}.";
			message = template.replace("{min}", this.min);
		} else if (typed_iso && this.max && typed_iso > this.max) {
			const template = this.getAttribute("date_max") || "Date must be on or before {max}.";
			message = template.replace("{max}", this.max);
		}

		if (error_el) error_el.textContent = message;

		// Only commit the public value once it's confirmed valid (or cleared) -
		// an invalid in-progress edit leaves the previously committed value intact.
		if (!message && (all_empty || typed_iso) && typed_iso !== this.hidden_input.value) {
			this.hidden_input.value = typed_iso;
			this.hidden_input.dispatchEvent(new Event("input", { bubbles: true }));
		}

		return !message;
	}
}

// ---------------------------------------------------------------------------
// locale segment layout
// ---------------------------------------------------------------------------

function build_segments(locale) {
	const formatter = new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", year: "numeric" });
	const parts = formatter.formatToParts(new Date(2000, 0, 1));

	const segments = [];
	for (const part of parts) {
		if (part.type === "day" || part.type === "month" || part.type === "year") {
			segments.push({ type: part.type });
		} else if (part.type === "literal") {
			segments.push({ type: "literal", text: part.value });
		}
	}
	return segments;
}

// ---------------------------------------------------------------------------
// value <-> segment conversion
// ---------------------------------------------------------------------------

function is_valid_calendar_date(iso) {
	const [year, month, day] = iso.split("-").map((part) => parseInt(part, 10));
	const date = new Date(Date.UTC(year, month - 1, day));
	return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function segment_values_from_iso(iso) {
	const values = { year: "", month: "", day: "" };
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
	if (match) {
		values.year = match[1];
		values.month = match[2];
		values.day = match[3];
	}
	return values;
}

function iso_from_segment_values(values) {
	const { year, month, day } = values;
	if (year.length === 4 && month.length === 2 && day.length === 2) {
		return `${year}-${month}-${day}`;
	}
	return "";
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function render_segments(display_el, segments, values, active) {
	display_el.innerHTML = "";
	let field_index = -1;

	for (const segment of segments) {
		if (segment.type === "literal") {
			display_el.append(document.createTextNode(segment.text));
			continue;
		}

		field_index += 1;
		const max_length = SEGMENT_LENGTHS[segment.type];
		const raw_value = values[segment.type] || "";
		const text = raw_value.padEnd(max_length, "_");

		const span = document.createElement("span");
		span.dataset.segmentIndex = String(field_index);
		span.dataset.segmentType = segment.type;
		span.className = "date-input-segment";
		span.classList.toggle("is-active", field_index === active);
		span.textContent = text;
		display_el.append(span);
	}
}

customElements.define("date-input", DateInput);
