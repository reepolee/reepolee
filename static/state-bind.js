/**
 * Declarative deepSignal <-> DOM binding.
 *
 * bind_state(app_state, watchEffect, root) wires:
 * - [data-bind="path"] form elements: two-way sync with app_state[path]
 *   (dot-notation supported, e.g. "profile.first_name")
 * - [data-key="path"] elements: one-way render of app_state[path] as textContent
 *
 * Usage (see routes/examples/signals/signals.ree, routes/examples/kitchen_sink):
 *   import { deepSignal, watchEffect } from "/alien-deepsignals.min.js";
 *   import { bind_state } from "/state-bind.js";
 *   const app_state = deepSignal({ counter: 100, profile: { first_name: "" } });
 *   bind_state(app_state, watchEffect);
 */

function get_value(obj, path) {
	return path.split(".").reduce((o, k) => o?.[k], obj);
}

function set_value(obj, path, val) {
	const keys = path.split(".");
	const last = keys.pop();
	const target = keys.reduce((o, k) => o[k], obj);
	target[last] = val;
}

export function bind_state(app_state, watchEffect, root = document) {
	root.querySelectorAll("[data-bind]").forEach((bound_el) => {
		const key_path = bound_el.dataset.bind;

		watchEffect(() => {
			bound_el.value = get_value(app_state, key_path) ?? "";
		});

		bound_el.addEventListener("input", () => {
			const raw = bound_el.value;
			set_value(app_state, key_path, bound_el.type === "number" ? Number(raw) : raw);
		});
	});

	root.querySelectorAll("[data-key]").forEach((span_el) => {
		const key_path = span_el.dataset.key;

		watchEffect(() => {
			span_el.textContent = get_value(app_state, key_path) ?? "";
		});
	});
}
