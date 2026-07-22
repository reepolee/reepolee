/**
 * <image-upload> component client behavior.
 *
 * Uploads a file directly to POST /system/images/save (same endpoint used by
 * the full image editor) and stores the returned s3_url into the wrapper's
 * hidden input, so the value is submitted with the surrounding form.
 */

(() => {
	function init_wrapper(wrapper) {
		if (wrapper.dataset.iuInit) return;
		wrapper.dataset.iuInit = "1";

		const folder = wrapper.dataset.folder || "";
		const module = wrapper.dataset.module || "";
		const msg_invalid_type = wrapper.dataset.msgInvalidType || "Only image files are allowed";
		const msg_uploaded = wrapper.dataset.msgUploaded || "Uploaded";
		const msg_failed = wrapper.dataset.msgFailed || "Upload failed";
		const hidden = wrapper.querySelector(".image-upload-value");
		const csrf_input = wrapper.querySelector(".image-upload-csrf");
		const status_el = wrapper.querySelector(".image-upload-status");
		const dropzone = wrapper.querySelector(".image-upload-dropzone");
		const file_input = wrapper.querySelector(".image-upload-file");
		const preview_img = wrapper.querySelector(".image-upload-preview");
		const placeholder = wrapper.querySelector(".image-upload-placeholder");
		const spinner = wrapper.querySelector(".image-upload-spinner");

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

		function set_preview(url) {
			if (!preview_img) return;
			if (url) {
				preview_img.src = url;
				preview_img.classList.remove("hidden");
				placeholder?.classList.add("hidden");
			} else {
				preview_img.src = "";
				preview_img.classList.add("hidden");
				placeholder?.classList.remove("hidden");
			}
		}

		async function upload_file(file) {
			if (!file) return;
			if (!file.type.startsWith("image/")) {
				show_status(msg_invalid_type, "error");
				return;
			}

			clear_status();
			set_busy(true);

			const form_data = new FormData();
			form_data.append("_csrf_token", csrf_input?.value || "");
			form_data.append("image", file, file.name);
			form_data.append("original_filename", file.name);
			if (folder) form_data.append("folder", folder);
			if (module) form_data.append("module", module);
			form_data.append("keep_original", "0");

			try {
				const res = await fetch("/system/images/save", { method: "POST", body: form_data, redirect: "manual" });

				if (res.type === "opaqueredirect" || res.status === 0) { throw new Error(msg_failed); }

				const is_json = res.headers.get("Content-Type")?.includes("application/json");
				const result = is_json ? await res.json() : await res.text();

				if (!res.ok) {
					throw new Error(typeof result === "string" ? result : result?.message || msg_failed);
				}

				if (!is_json || !result?.s3_url) { throw new Error(msg_failed); }

				if (hidden) {
					hidden.value = result.s3_url || "";
					hidden.dispatchEvent(new Event("input", { bubbles: true }));
					hidden.dispatchEvent(new Event("change", { bubbles: true }));
				}
				set_preview(result.s3_url || "");
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

		hidden?.addEventListener("iu:sync", () => {
			clear_status();
			set_preview(hidden.value || "");
		});
	}

	function init_all() {
		document.querySelectorAll(".image-upload-wrapper").forEach(init_wrapper);
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", init_all);
	} else {
		init_all();
	}
})();
