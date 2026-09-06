// eslint-disable-next-line no-unused-vars
class CheckboxGroup {
	constructor({
		selectAllSelector = "#select_all",
		deselectSelector = "#deselect_all",
		checkboxSelector = `input[name="checkboxes[]"]`,
		buttonSelectors = ["#action", "#action_2"],
	}) {
		this.selectAll = $(selectAllSelector);
		this.deselectBtn = deselectSelector ? $(deselectSelector) : null;

		this.checkboxSelector = checkboxSelector;

		this.buttons = buttonSelectors.map((sel) => $(sel)).filter(Boolean);

		this.bindEvents();

		// Sync UI on page load
		this.updateMainCheckbox();
	}

	getAll() {
		return $$(this.checkboxSelector);
	}

	getSelected() {
		return $$(`${this.checkboxSelector}:checked`);
	}

	getMainState() {
		const all = this.getAll();
		const selected = this.getSelected();

		if (selected.length === 0) return 0;
		if (selected.length === all.length) return 1;

		return -1; // indeterminate
	}

	updateMainCheckbox() {
		const state = this.getMainState();

		if (state === -1) {
			this.selectAll.checked = false;
			this.selectAll.indeterminate = true;
		}

		if (state === 0) {
			this.selectAll.checked = false;
			this.selectAll.indeterminate = false;
		}

		if (state === 1) {
			this.selectAll.checked = true;
			this.selectAll.indeterminate = false;
		}

		this.enableButtons(this.getSelected().length > 0);
	}

	toggleAllSpecial() {
		const state = this.getMainState();
		const all = this.getAll();

		if (state === -1) {
			// 🔁 invert behavior (your original feature)
			all.forEach((cb) => {
				cb.checked = !cb.checked;
			});

			this.selectAll.indeterminate = true;
		} else {
			const checked = this.selectAll.checked;

			all.forEach((cb) => {
				cb.checked = checked;
			});

			this.selectAll.indeterminate = false;
		}

		this.enableButtons(this.getSelected().length > 0);
	}

	deselectAll() {
		this.selectAll.checked = false;
		this.selectAll.indeterminate = false;

		this.getAll().forEach((cb) => {
			cb.checked = false;
		});

		this.enableButtons(false);
	}

	enableButtons(enabled) {
		this.buttons.forEach((btn) => {
			btn.disabled = !enabled;
		});
	}

	bindEvents() {
		// select-all
		this.selectAll.addEventListener("change", () => {
			this.toggleAllSpecial();
		});

		// reset button
		if (this.deselectBtn) {
			this.deselectBtn.addEventListener("click", () => {
				this.deselectAll();
			});
		}

		// individual checkboxes
		this.getAll().forEach((cb) => {
			cb.addEventListener("change", () => {
				this.updateMainCheckbox();
			});
		});
	}
}
