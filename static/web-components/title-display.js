class TitleDisplay extends HTMLElement {
	constructor() {
		super();

		// Attach shadow DOM for style encapsulation
		this.attachShadow({ mode: "open" });
	}

	// Define which attributes to watch
	static get observedAttributes() {
		return ["capitalize", "pluralize"];
	}

	// Called when the element is inserted into the DOM
	connectedCallback() {
		// Watch for text content changes
		const observer = new MutationObserver(() => this.render());
		observer.observe(this, { childList: true, characterData: true, subtree: true });
		this.render();
	}

	// Called when watched attributes change
	attributeChangedCallback(_name, old_value, new_value) {
		if (old_value !== new_value) {
			this.render();
		}
	}

	// Get text content from slot
	get title() {
		return this.textContent.trim() || "";
	}

	get capitalize() {
		return this.hasAttribute("capitalize");
	}

	get pluralize() {
		return this.hasAttribute("pluralize");
	}

	// Process the title based on attributes
	process_title(text) {
		let result = text;

		if (this.capitalize) {
			result = result.charAt(0).toUpperCase() + result.slice(1);
		}

		if (this.pluralize) {
			// Simple pluralization logic
			if (result.endsWith("y")) {
				result = `${result.slice(0, -1)}ies`;
			} else {
				result = `${result}s`;
			}
		}

		return result;
	}

	// Render the component
	render() {
		const processed_title = this.process_title(this.title);

		this.shadowRoot.innerHTML = `${processed_title}`;
	}
}

// Register the custom element
customElements.define("title-display", TitleDisplay);
