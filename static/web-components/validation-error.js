class ValidationError extends HTMLElement {
	constructor() {
		super();

		// Attach shadow DOM for style encapsulation
		this.attachShadow({ mode: "open" });
	}

	// Define which attributes to watch
	static get observedAttributes() {
		return ["id", "class"];
	}

	// Called when the element is inserted into the DOM
	connectedCallback() {
		this.setup_shadow_dom();
		this.render();

		// Listen for slot changes to re-render when content changes
		const slot = this.shadowRoot.querySelector("slot");
		slot.addEventListener("slotchange", () => this.render());
	}

	// Called when watched attributes change
	attributeChangedCallback(_name, old_value, new_value) {
		if (old_value !== new_value) {
			this.render();
		}
	}

	// Get custom class attribute
	get custom_class() {
		return this.getAttribute("class") || "";
	}

	// Get errors from slotted content
	get errors() {
		const slot = this.shadowRoot.querySelector("slot");
		const nodes = slot.assignedNodes({ flatten: true });
		const errors = [];

		nodes.forEach((node) => {
			if (node.nodeType === Node.TEXT_NODE) {
				const text = node.textContent.trim();
				if (text) errors.push(text);
			} else if (node.nodeType === Node.ELEMENT_NODE) {
				errors.push(node.textContent.trim());
			}
		});

		return errors;
	}

	// Setup shadow DOM once
	setup_shadow_dom() {
		this.shadowRoot.innerHTML = `
			<style>
				:host {
					display: block;
				}

				.validation-error-container {
					display: grid;
				}

			</style>

			<div class="validation-error-container">
				<slot></slot>
			</div>
		`;

		this.error_container = this.shadowRoot.querySelector(".validation-error-container");
	}

	// Render the component
	render() {
		if (!this.error_container) return;

		const custom_class = this.custom_class;

		this.error_container.className = `validation-error-container ${custom_class}`;

		// Wrap each error item
		const slot = this.shadowRoot.querySelector("slot");
		slot.assignedNodes({ flatten: true }).forEach((node) => {
			if (node.nodeType === Node.TEXT_NODE) {
				const wrapper = document.createElement("div");
				wrapper.textContent = node.textContent.trim();
				node.parentNode.replaceChild(wrapper, node);
			}
		});
	}
}

// Register the custom element
customElements.define("validation-error", ValidationError);
