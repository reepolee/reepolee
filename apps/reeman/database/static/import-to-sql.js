(() => {
	const form = document.getElementById("import-to-sql-form");
	if (!(form instanceof HTMLFormElement)) return;

	const fileInput = form.querySelector('input[name="json_file"]');
	const tableInput = form.querySelector('input[name="table_name"]');
	const status = document.getElementById("import-inspection-status");
	const jsonOptions = document.getElementById("json-import-options");
	const spreadsheetOptions = document.getElementById("spreadsheet-import-options");
	const sheetList = document.getElementById("spreadsheet-sheet-list");
	const selectionsInput = form.querySelector('input[name="sheet_selections"]');
	const submitButton = form.querySelector('button[type="submit"]');
	if (!(fileInput instanceof HTMLInputElement)
		|| !(tableInput instanceof HTMLInputElement)
		|| !(status instanceof HTMLElement)
		|| !(jsonOptions instanceof HTMLElement)
		|| !(spreadsheetOptions instanceof HTMLElement)
		|| !(sheetList instanceof HTMLElement)
		|| !(selectionsInput instanceof HTMLInputElement)
		|| !(submitButton instanceof HTMLButtonElement)) return;

	function resetInspection() {
		jsonOptions.hidden = true;
		spreadsheetOptions.hidden = true;
		tableInput.required = false;
		tableInput.value = "";
		sheetList.replaceChildren();
		selectionsInput.value = "[]";
		submitButton.disabled = true;
	}

	function selectedSheets() {
		const selections = [];
		const checkboxes = sheetList.querySelectorAll('input[type="checkbox"][data-sheet]');
		for (const checkbox of checkboxes) {
			if (!(checkbox instanceof HTMLInputElement) || !checkbox.checked) continue;
			const row = checkbox.closest("[data-sheet-row]");
			const nameInput = row?.querySelector('input[data-table-name]');
			if (!(nameInput instanceof HTMLInputElement)) continue;
			selections.push({ sheet: checkbox.dataset.sheet || "", table: nameInput.value.trim() });
		}
		return selections;
	}

	function updateSpreadsheetSelection() {
		const selections = selectedSheets();
		selectionsInput.value = JSON.stringify(selections);
		const namesAreValid = selections.every((selection) => /^[a-z][a-z0-9_]*$/.test(selection.table));
		submitButton.disabled = selections.length === 0 || !namesAreValid;
	}

	function renderSpreadsheet(sheets) {
		spreadsheetOptions.hidden = false;
		for (const sheet of sheets) {
			const row = document.createElement("div");
			row.className = "grid grid-cols-[auto_1fr] gap-3 items-start rounded-md border border-border p-3";
			row.dataset.sheetRow = "1";

			const checkbox = document.createElement("input");
			checkbox.type = "checkbox";
			checkbox.dataset.sheet = sheet.name;
			checkbox.checked = sheet.row_count > 0;
			checkbox.disabled = sheet.row_count === 0;

			const content = document.createElement("div");
			content.className = "grid gap-2";
			const heading = document.createElement("strong");
			heading.textContent = sheet.name;
			const summary = document.createElement("span");
			summary.className = "text-sm text-text-secondary";
			const columnText = sheet.columns.length > 0 ? sheet.columns.join(", ") : form.dataset.emptyLabel;
			summary.textContent = `${sheet.row_count} ${form.dataset.rowsLabel} - ${form.dataset.columnsLabel}: ${columnText}`;
			const nameInput = document.createElement("input");
			nameInput.dataset.tableName = "1";
			nameInput.value = sheet.table_name;
			nameInput.pattern = "[a-z][a-z0-9_]*";
			nameInput.disabled = sheet.row_count === 0;

			content.append(heading, summary, nameInput);
			row.append(checkbox, content);
			sheetList.append(row);
		}
		updateSpreadsheetSelection();
	}

	fileInput.addEventListener("change", async () => {
		resetInspection();
		status.textContent = "";
		if (!fileInput.files?.length) return;
		status.textContent = form.dataset.inspectingLabel || "";
		try {
			const response = await fetch(form.dataset.inspectUrl || "", {
				method: "POST",
				body: new FormData(form),
			});
			const result = await response.json();
			if (!response.ok || result.error) throw new Error(result.error || form.dataset.inspectionError);
			if (result.kind === "json") {
				jsonOptions.hidden = false;
				tableInput.required = true;
				tableInput.value = result.table_name;
				const columnText = result.columns.length > 0 ? result.columns.join(", ") : "";
				status.textContent = `${result.row_count} ${form.dataset.rowsLabel} - ${form.dataset.columnsLabel}: ${columnText}`;
				submitButton.disabled = false;
				return;
			}
			status.textContent = "";
			renderSpreadsheet(result.sheets || []);
		} catch (error) {
			resetInspection();
			status.textContent = error instanceof Error ? error.message : (form.dataset.inspectionError || "");
		}
	});

	sheetList.addEventListener("input", updateSpreadsheetSelection);
	sheetList.addEventListener("change", updateSpreadsheetSelection);
	form.addEventListener("submit", (event) => {
		if (!spreadsheetOptions.hidden) updateSpreadsheetSelection();
		if (submitButton.disabled || !form.reportValidity()) event.preventDefault();
	});
})();
