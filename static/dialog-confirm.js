/**
 * Dialog open handler - ensures [command='show-modal'] buttons call
 * showModal() directly, since the experimental Invoker Commands API
 * may open dialogs as non-modal (allowing background interactions).
 */
document.addEventListener("click", (e) => {
	const btn = e.target.closest("[command='show-modal'][commandfor]");
	if (!btn) return;
	const dialog_id = btn.getAttribute("commandfor");
	if (!dialog_id) return;
	const dialog = document.getElementById(dialog_id);
	if (!dialog || !(dialog instanceof HTMLDialogElement)) return;

	// If the dialog isn't open yet, the invoker API didn't handle it,
	// or opened it as non-modal. Close and reopen as modal.
	if (dialog.open) {
		dialog.close();
	}
	dialog.showModal();
});

/**
 * Confirm actions use the native Invoker Commands API custom command
 * `command="--confirm"`. The dialog listens for it directly:
 *
 *   dialog.addEventListener("command", (e) => {
 *     if (e.command !== "--confirm") return;
 *     dialog.close();
 *     // ...do the work
 *   });
 *
 * No shared JS is needed for confirm - the browser dispatches the
 * `command` event on the dialog (the `commandfor` target).
 */
