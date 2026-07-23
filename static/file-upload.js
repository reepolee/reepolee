/**
 * <file-upload> component client behavior.
 *
 * Uploads a file directly to POST /system/files/save and stores the returned
 * s3_url into the wrapper's hidden input, so the value is submitted with the
 * surrounding form.
 */

(() => {
	function init_wrapper(wrapper) {
		if (wrapper.dataset.fuInit) return;
		wrapper.dataset.fuInit = "1";

		const folder_input_id = wrapper.dataset.folderInput || "";
		const folder_input = folder_input_id ? document.getElementById(folder_input_id) : null;
		const static_folder = wrapper.dataset.folder || "";
		const module = wrapper.dataset.module || "";

		function current_folder() { return folder_input ? folder_input.value.trim() : static_folder; }
		const msg_invalid_type = wrapper.dataset.msgInvalidType || "File type not allowed";
		const msg_uploaded = wrapper.dataset.msgUploaded || "Uploaded";
		const msg_failed = wrapper.dataset.msgFailed || "Upload failed";
		const hidden = wrapper.querySelector(".file-upload-value");
		const csrf_input = wrapper.querySelector(".file-upload-csrf");
		const status_el = wrapper.querySelector(".file-upload-status");
		const dropzone = wrapper.querySelector(".file-upload-dropzone");
		const file_input = wrapper.querySelector(".file-upload-file");
		const filename_el = wrapper.querySelector(".file-upload-filename");
		const placeholder = wrapper.querySelector(".file-upload-placeholder");
		const spinner = wrapper.querySelector(".file-upload-spinner");

		function show_status(message, kind) {
			if (!status_el) return;
			status_el.textContent = message;
			status_el.classList.remove("hidden");
			status_el.style.color = kind === "error" ? "var(--color-danger)" : "var(--color-success)";
		}

		function clear_status() {
			if (!status_el) return;
			status_el.textContent = "";
			status_el.classList.add("hidden");
		}

		function set_busy(busy) {
			spinner?.classList.toggle("hidden", !busy);
			dropzone?.classList.toggle("pointer-events-none", busy);
		}

		function set_filename(name) {
			if (!filename_el) return;
			if (name) {
				filename_el.textContent = name;
				filename_el.classList.remove("hidden");
				placeholder?.classList.add("hidden");
			} else {
				filename_el.textContent = "";
				filename_el.classList.add("hidden");
				placeholder?.classList.remove("hidden");
			}
		}

		async function upload_file(file) {
			if (!file) return;

			clear_status();
			set_busy(true);

			const form_data = new FormData();
			form_data.append("_csrf_token", csrf_input?.value || "");
			form_data.append("file", file, file.name);
			form_data.append("original_filename", file.name);
			const folder = current_folder();
			if (folder) form_data.append("folder", folder);
			if (module) form_data.append("module", module);

			try {
				const res = await fetch("/system/files/save", { method: "POST", body: form_data, redirect: "manual" });

				if (res.type === "opaqueredirect" || res.status === 0) { throw new Error(msg_failed); }

				const is_json = res.headers.get("Content-Type")?.includes("application/json");
				const result = is_json ? await res.json() : await res.text();

				if (!res.ok) {
					throw new Error(typeof result === "string" ? result : result?.message || msg_failed);
				}

				if (!is_json || !result?.s3_url) { throw new Error(msg_failed); }

				if (hidden) {
					hidden.value = result.s3_url || "";
					hidden.dataset.dbId = result.db_id != null ? String(result.db_id) : "";
					hidden.dispatchEvent(new Event("input", { bubbles: true }));
					hidden.dispatchEvent(new Event("change", { bubbles: true }));
				}
				set_filename(result.original_filename || result.filename || "");
				show_status(msg_uploaded, "success");
			} catch (err) {
				show_status(err.message || msg_failed, "error");
			} finally {
				set_busy(false);
			}
		}

		dropzone.addEventListener("click", () => file_input.click());

		dropzone.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				file_input.click();
			}
		});

		file_input.addEventListener("change", () => {
			if (file_input.files?.[0]) upload_file(file_input.files[0]);
			file_input.value = "";
		});

		dropzone.addEventListener("dragover", (e) => {
			e.preventDefault();
			dropzone.classList.add("border-blue-500", "bg-blue-50");
		});

		dropzone.addEventListener("dragleave", () => {
			dropzone.classList.remove("border-blue-500", "bg-blue-50");
		});

		dropzone.addEventListener("drop", (e) => {
			e.preventDefault();
			dropzone.classList.remove("border-blue-500", "bg-blue-50");
			if (e.dataTransfer?.files?.[0]) upload_file(e.dataTransfer.files[0]);
		});

		hidden?.addEventListener("fu:sync", () => {
			clear_status();
			const url = hidden.value || "";
			set_filename(url ? url.split("/").pop() : "");
		});
	}

	function init_all() {
		document.querySelectorAll(".file-upload-wrapper").forEach(init_wrapper);
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", init_all);
	} else {
		init_all();
	}
})();
