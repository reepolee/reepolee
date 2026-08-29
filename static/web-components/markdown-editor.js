/**
 * markdown-editor - form-participating WYSIWYG markdown editor.
 *
 * Wraps a real <textarea name="..."> (light DOM, no shadow root) so
 * FormController's `textarea[name]` selector and validation-error wiring
 * keep working unchanged. A contenteditable surface renders the markdown
 * as formatted content; edits are serialized back into the textarea on
 * every input, dispatching bubbling input events - the same sync pattern
 * file-upload.js uses for its hidden field.
 *
 * Supported subset (matches Bun.markdown.html() on the server): h1-h3,
 * bold, italic, inline code, links, unordered/ordered lists, blockquote.
 */

const TOOLBAR_BUTTONS = [
	{ command: "bold", label: "B", title: "Bold" },
	{ command: "italic", label: "I", title: "Italic" },
	{ command: "code", label: "</>", title: "Code" },
	{ command: "link", label: "🔗", title: "Link" },
	{ command: "h1", label: "H1", title: "Heading 1" },
	{ command: "h2", label: "H2", title: "Heading 2" },
	{ command: "h3", label: "H3", title: "Heading 3" },
	{ command: "ul", label: "•", title: "Bulleted list" },
	{ command: "ol", label: "1.", title: "Numbered list" },
	{ command: "quote", label: "❝", title: "Quote" },
	{ command: "raw", label: "MD", title: "Edit raw Markdown" },
];

class MarkdownEditor extends HTMLElement {
	static observedAttributes = ["disabled"];

	get disabled() { return this.hasAttribute("disabled"); }
	set disabled(value) { this.toggleAttribute("disabled", Boolean(value)); }

	connectedCallback() {
		if (this._initialized) return;
		this._initialized = true;

		const name = this.getAttribute("name") || "";
		const initial_value = this.hasAttribute("value") ? this.getAttribute("value") : this.textContent;
		const placeholder = this.getAttribute("placeholder") || "";

		this.textarea = document.createElement("textarea");
		this.textarea.name = name;
		this.textarea.value = initial_value || "";
		this.textarea.className = "markdown-editor-textarea hidden";
		this.textContent = "";

		this.toolbar_el = document.createElement("div");
		this.toolbar_el.className = "markdown-editor-toolbar";
		this.appendChild(this.toolbar_el);
		this.appendChild(this.textarea);

		this.surface_el = document.createElement("div");
		this.surface_el.className = "markdown-editor-surface";
		this.surface_el.contentEditable = "true";
		this.surface_el.dataset.placeholder = placeholder;
		this.surface_el.innerHTML = markdown_to_html(initial_value || "");
		this.surface_el.dataset.empty = initial_value ? "false" : "true";
		this.appendChild(this.surface_el);

		this.build_toolbar();
		this.bind_events();
		this.sync_disabled_state();
	}

	attributeChangedCallback(name) {
		if (name === "disabled" && this._initialized) this.sync_disabled_state();
	}

	sync_disabled_state() {
		const disabled = this.disabled;
		this.textarea.disabled = disabled;
		this.surface_el.contentEditable = disabled ? "false" : "true";
		for (const button of this.toolbar_el.querySelectorAll("button")) {
			button.disabled = disabled;
		}
	}

	build_toolbar() {
		for (const { command, label, title } of TOOLBAR_BUTTONS) {
			const btn = document.createElement("button");
			btn.type = "button";
			btn.className = "markdown-editor-btn";
			btn.textContent = label;
			btn.title = title;
			btn.dataset.command = command;
			btn.addEventListener("mousedown", (e) => {
				e.preventDefault();
				this.run_command(command);
			});
			this.toolbar_el.appendChild(btn);
		}
	}

	run_command(command) {
		if (command === "raw") {
			this.toggle_raw_mode();
			return;
		}
		if (this.raw_mode) {
			this.run_raw_command(command);
			return;
		}
		this.surface_el.focus();

		if (command === "bold" || command === "italic") {
			document.execCommand(command === "bold" ? "bold" : "italic");
		} else if (command === "code") {
			toggle_code_selection(this.surface_el);
		} else if (command === "link") {
			const url = window.prompt("URL:", "https://");
			if (url) document.execCommand("createLink", false, url);
		} else if (command === "h1" || command === "h2" || command === "h3") {
			document.execCommand("formatBlock", false, command);
		} else if (command === "ul") {
			document.execCommand("insertUnorderedList");
		} else if (command === "ol") {
			document.execCommand("insertOrderedList");
		} else if (command === "quote") {
			document.execCommand("formatBlock", false, "blockquote");
		}

		this.sync();
	}

	run_raw_command(command) {
		const textarea = this.textarea;
		const selection_start = textarea.selectionStart;
		const selection_end = textarea.selectionEnd;
		if (selection_start === selection_end) return;

		if (command === "bold") {
			toggle_raw_wrap(textarea, "**");
		} else if (command === "italic") {
			toggle_raw_wrap(textarea, "*");
		} else if (command === "code") {
			toggle_raw_wrap(textarea, "`");
		} else if (command === "link") {
			const url = window.prompt("URL:", "https://");
			if (url) wrap_raw_selection(textarea, "[", `](${url})`);
		} else if (command === "h1" || command === "h2" || command === "h3") {
			const level = Number(command.slice(1));
			format_raw_lines(textarea, (line) => `${"#".repeat(level)} ${line.replace(/^#{1,3}\s+/, "")}`);
		} else if (command === "ul") {
			format_raw_lines(textarea, (line) => `- ${line.replace(/^[-*]\s+/, "")}`);
		} else if (command === "ol") {
			format_raw_lines(textarea, (line, index) => `${index + 1}. ${line.replace(/^\d+\.\s+/, "")}`);
		} else if (command === "quote") {
			format_raw_lines(textarea, (line) => `> ${line.replace(/^>\s+/, "")}`);
		}
	}

	bind_events() {
		this.surface_el.addEventListener("input", () => this.sync());
		this.textarea.addEventListener("input", () => {
			this.surface_el.dataset.empty = this.textarea.value ? "false" : "true";
		});
		this.surface_el.addEventListener("copy", (event) => this.copy_markdown(event));
		this.surface_el.addEventListener("paste", (event) => this.paste_markdown(event));
	}

	toggle_raw_mode() {
		if (this.disabled) return;
		if (!this.raw_mode) {
			this.sync();
			this.raw_mode = true;
			this.textarea.classList.remove("hidden");
			this.surface_el.hidden = true;
			this.sync_disabled_state();
			this.textarea.focus();
			return;
		}

		this.raw_mode = false;
		this.surface_el.innerHTML = markdown_to_html(this.textarea.value);
		this.surface_el.dataset.empty = this.textarea.value ? "false" : "true";
		this.textarea.classList.add("hidden");
		this.surface_el.hidden = false;
		this.sync_disabled_state();
		this.surface_el.focus();
	}

	copy_markdown(event) {
		const selection = window.getSelection();
		if (!selection || selection.rangeCount === 0) return;
		const range = selection.getRangeAt(0);
		if (!this.surface_el.contains(range.commonAncestorContainer)) return;

		const markdown = selection_covers_root(range, this.surface_el)
			? this.textarea.value
			: markdown_from_range(range);
		if (!markdown || !event.clipboardData) return;

		event.preventDefault();
		event.clipboardData.setData("application/x-reepolee-markdown", markdown);
		event.clipboardData.setData("text/plain", markdown);
		event.clipboardData.setData("text/html", markdown_to_html(markdown));
	}

	paste_markdown(event) {
		const clipboard = event.clipboardData;
		const private_markdown = clipboard?.getData("application/x-reepolee-markdown") || "";
		const plain_text = clipboard?.getData("text/plain") || "";
		const markdown = private_markdown || plain_text;
		if (!markdown || (!private_markdown && !looks_like_markdown(markdown))) return;

		event.preventDefault();
		this.surface_el.innerHTML = markdown_to_html(markdown);
		this.sync();
	}

	sync() {
		const markdown = html_to_markdown(this.surface_el);
		this.textarea.value = markdown;
		this.surface_el.dataset.empty = markdown ? "false" : "true";
		this.textarea.dispatchEvent(new Event("input", { bubbles: true }));
	}

	/**
	 * Empty the editor - clears both the contenteditable surface and the
	 * underlying form textarea, e.g. when a form built once is reset between
	 * submissions (issue #417).
	 */
	clear() {
		this.raw_mode = false;
		this.surface_el.innerHTML = "<p></p>";
		this.surface_el.dataset.empty = "true";
		this.surface_el.hidden = false;
		this.textarea.value = "";
		this.textarea.classList.add("hidden");
		this.textarea.dispatchEvent(new Event("input", { bubbles: true }));
	}
}

function selection_covers_root(range, root) {
	const root_range = document.createRange();
	root_range.selectNodeContents(root);
	return range.compareBoundaryPoints(Range.START_TO_START, root_range) <= 0
		&& range.compareBoundaryPoints(Range.END_TO_END, root_range) >= 0;
}

function looks_like_markdown(value) {
	return /^(#{1,3}\s|[-*]\s|\d+\.\s|>\s)|\*\*.+?\*\*/m.test(value);
}

function markdown_from_range(range) {
	const copied_content = range.cloneContents();
	const copied_root = document.createElement("div");
	copied_root.append(copied_content);
	return html_to_markdown(copied_root);
}

function wrap_selection_with_tag(root, tag_name) {
	const selection = window.getSelection();
	if (!selection || selection.rangeCount === 0) return;
	const range = selection.getRangeAt(0);
	if (!root.contains(range.commonAncestorContainer)) return;
	if (range.collapsed) return;

	const wrapper = document.createElement(tag_name);
	wrapper.appendChild(range.extractContents());
	range.insertNode(wrapper);
	selection.removeAllRanges();
	const new_range = document.createRange();
	new_range.selectNodeContents(wrapper);
	selection.addRange(new_range);
}

function toggle_code_selection(root) {
	const selection = window.getSelection();
	if (!selection || selection.rangeCount === 0) return;
	const range = selection.getRangeAt(0);
	if (!root.contains(range.commonAncestorContainer) || range.collapsed) return;

	const start_code = closest_code_element(range.startContainer, root);
	const end_code = closest_code_element(range.endContainer, root);
	if (!start_code || start_code !== end_code) {
		wrap_selection_with_tag(root, "code");
		return;
	}

	const start_container = range.startContainer;
	const start_offset = range.startOffset;
	const end_container = range.endContainer;
	const end_offset = range.endOffset;
	const parent = start_code.parentNode;
	if (!parent) return;

	while (start_code.firstChild) parent.insertBefore(start_code.firstChild, start_code);
	start_code.remove();

	const unwrapped_range = document.createRange();
	unwrapped_range.setStart(start_container, start_offset);
	unwrapped_range.setEnd(end_container, end_offset);
	selection.removeAllRanges();
	selection.addRange(unwrapped_range);
}

function closest_code_element(node, root) {
	let element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
	while (element && element !== root) {
		if (element.tagName === "CODE") return element;
		element = element.parentElement;
	}
	return null;
}

function toggle_raw_wrap(textarea, marker) {
	const selection_start = textarea.selectionStart;
	const selection_end = textarea.selectionEnd;
	const value = textarea.value;
	const selected_value = value.slice(selection_start, selection_end);
	const before_selection = value.slice(0, selection_start);
	const after_selection = value.slice(selection_end);

	if (before_selection.endsWith(marker) && after_selection.startsWith(marker)) {
		const before_marker = before_selection.slice(0, -marker.length);
		const after_marker = after_selection.slice(marker.length);
		update_raw_value(textarea, `${before_marker}${selected_value}${after_marker}`, selection_start - marker.length, selection_end - marker.length);
		return;
	}

	if (selected_value.startsWith(marker) && selected_value.endsWith(marker)) {
		const unwrapped_value = selected_value.slice(marker.length, -marker.length);
		update_raw_value(textarea, `${before_selection}${unwrapped_value}${after_selection}`, selection_start, selection_end - marker.length * 2);
		return;
	}

	wrap_raw_selection(textarea, marker, marker);
}

function wrap_raw_selection(textarea, before, after) {
	const selection_start = textarea.selectionStart;
	const selection_end = textarea.selectionEnd;
	const value = textarea.value;
	const selected_value = value.slice(selection_start, selection_end);
	const before_selection = value.slice(0, selection_start);
	const after_selection = value.slice(selection_end);
	const next_value = `${before_selection}${before}${selected_value}${after}${after_selection}`;
	const next_start = selection_start + before.length;
	const next_end = next_start + selected_value.length;
	update_raw_value(textarea, next_value, next_start, next_end);
}

function format_raw_lines(textarea, formatter) {
	const selection_start = textarea.selectionStart;
	const selection_end = textarea.selectionEnd;
	const value = textarea.value;
	const line_start = value.lastIndexOf("\n", selection_start - 1) + 1;
	const next_line_index = value.indexOf("\n", selection_end);
	const line_end = next_line_index === -1 ? value.length : next_line_index;
	const selected_lines = value.slice(line_start, line_end);
	const lines = selected_lines.split("\n");
	const formatted_lines = lines.map((line, index) => formatter(line, index));
	const formatted_value = formatted_lines.join("\n");
	const before_lines = value.slice(0, line_start);
	const after_lines = value.slice(line_end);
	const next_value = `${before_lines}${formatted_value}${after_lines}`;
	const next_start = line_start;
	const next_end = line_start + formatted_value.length;
	update_raw_value(textarea, next_value, next_start, next_end);
}

function update_raw_value(textarea, value, selection_start, selection_end) {
	textarea.value = value;
	textarea.setSelectionRange(selection_start, selection_end);
	textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

// ---------------------------------------------------------------------------
// markdown -> HTML (initial load into the contenteditable surface)
// ---------------------------------------------------------------------------

function markdown_to_html(markdown) {
	const lines = markdown.split("\n");
	const html_blocks = [];
	let list_tag = null;
	let list_items = [];

	function flush_list() {
		if (!list_tag) return;
		html_blocks.push(`<${list_tag}>${list_items.join("")}</${list_tag}>`);
		list_tag = null;
		list_items = [];
	}

	for (const line of lines) {
		const heading_match = /^(#{1,3})\s+(.*)$/.exec(line);
		const ul_match = /^[-*]\s+(.*)$/.exec(line);
		const ol_match = /^\d+\.\s+(.*)$/.exec(line);
		const quote_match = /^>\s?(.*)$/.exec(line);

		if (heading_match) {
			flush_list();
			const level = heading_match[1].length;
			html_blocks.push(`<h${level}>${inline_markdown_to_html(heading_match[2])}</h${level}>`);
		} else if (ul_match) {
			if (list_tag !== "ul") { flush_list(); list_tag = "ul"; }
			list_items.push(`<li>${inline_markdown_to_html(ul_match[1])}</li>`);
		} else if (ol_match) {
			if (list_tag !== "ol") { flush_list(); list_tag = "ol"; }
			list_items.push(`<li>${inline_markdown_to_html(ol_match[1])}</li>`);
		} else if (quote_match) {
			flush_list();
			html_blocks.push(`<blockquote>${inline_markdown_to_html(quote_match[1])}</blockquote>`);
		} else if (line.trim() === "") {
			flush_list();
		} else {
			flush_list();
			html_blocks.push(`<p>${inline_markdown_to_html(line)}</p>`);
		}
	}
	flush_list();

	return html_blocks.join("") || "<p></p>";
}

function inline_markdown_to_html(text) {
	return escape_html(text)
		.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
		.replace(/\*(.+?)\*/g, "<em>$1</em>")
		.replace(/`(.+?)`/g, "<code>$1</code>")
		.replace(/\[(.+?)\]\((\S+?)\)/g, `<a href="$2">$1</a>`);
}

function escape_html(text) {
	const div = document.createElement("div");
	div.textContent = text;
	return div.innerHTML;
}

// ---------------------------------------------------------------------------
// HTML -> markdown (serializing the contenteditable surface back out)
// ---------------------------------------------------------------------------

function html_to_markdown(root) {
	const blocks = [];
	for (const node of root.childNodes) {
		const block = block_node_to_markdown(node);
		if (block !== null) blocks.push(block);
	}
	return join_markdown_blocks(blocks);
}

function block_node_to_markdown(node) {
	if (node.nodeType === Node.TEXT_NODE) {
		const text = node.textContent.trim();
		return text ? text : null;
	}
	if (node.nodeType !== Node.ELEMENT_NODE) return null;

	const tag = node.tagName.toLowerCase();

	if (/^h[1-3]$/.test(tag)) {
		const level = Number(tag[1]);
		return `${"#".repeat(level)} ${inline_node_to_markdown(node)}`;
	}
	if (tag === "blockquote") {
		return `> ${inline_node_to_markdown(node)}`;
	}
	if (tag === "ul" || tag === "ol") {
		const items = Array.from(node.children).filter((c) => c.tagName === "LI");
		return items
			.map((li, i) => (tag === "ul" ? `- ${inline_node_to_markdown(li)}` : `${i + 1}. ${inline_node_to_markdown(li)}`))
			.join("\n");
	}
	if (tag === "li") return `- ${inline_node_to_markdown(node)}`;
	if (tag === "div") {
		const child_blocks = Array.from(node.childNodes)
			.map((child) => block_node_to_markdown(child))
			.filter((block) => block !== null);
		if (has_block_child(node)) return join_markdown_blocks(child_blocks);
		return child_blocks.join("") || null;
	}
	if (tag === "p") {
		const text = inline_node_to_markdown(node);
		return text ? text : null;
	}

	return inline_node_to_markdown(node) || null;
}

function join_markdown_blocks(blocks) {
	let markdown = "";
	let previous_is_list = false;
	for (const block of blocks) {
		const is_list = /^(?:[-*]\s|\d+\.\s)/.test(block);
		if (markdown) markdown += previous_is_list && is_list ? "\n" : "\n\n";
		markdown += block;
		previous_is_list = is_list;
	}
	return markdown;
}

function has_block_child(node) {
	for (const child of node.children) {
		const tag = child.tagName.toLowerCase();
		if (/^(h[1-3]|blockquote|ul|ol|li|p|div)$/.test(tag)) return true;
	}
	return false;
}

function inline_node_to_markdown(node) {
	let out = "";
	for (const child of node.childNodes) {
		if (child.nodeType === Node.TEXT_NODE) {
			out += child.textContent;
		} else if (child.nodeType === Node.ELEMENT_NODE) {
			const tag = child.tagName.toLowerCase();
			const inner = inline_node_to_markdown(child);
			if (tag === "strong" || tag === "b") out += `**${inner}**`;
			else if (tag === "em" || tag === "i") out += `*${inner}*`;
			else if (tag === "code") out += `\`${inner}\``;
			else if (tag === "a") out += `[${inner}](${child.getAttribute("href") || ""})`;
			else if (tag === "br") out += "\n";
			else out += inner;
		}
	}
	return out.trim();
}

customElements.define("markdown-editor", MarkdownEditor);
