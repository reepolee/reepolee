/**
 * SVG icon HTML strings for use in TypeScript code that generates HTML strings
 * (e.g., streaming index handlers that build pagination HTML with template literals).
 *
 * For Ree templates, use the `<ree-icon>` component in `components/ree-icon.ree`.
 * This module is the TS-side equivalent - a single entry point for maintaining SVG definitions.
 */
export const ICONS = {
	chevrons_left: "<svg viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path fill=\"currentColor\" d=\"M12 17.308L6.692 12L12 6.692l.708.708l-4.6 4.6l4.6 4.6z\"/><path fill=\"currentColor\" d=\"M17.692 17.308L12.384 12l5.308-5.308l.708.708l-4.6 4.6l4.6 4.6z\"/></svg>",
	chevron_left: "<svg viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path fill=\"currentColor\" d=\"M14 17.308L8.692 12L14 6.692l.708.708l-4.6 4.6l4.6 4.6z\"/></svg>",
	chevron_right: "<svg viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path fill=\"currentColor\" d=\"m13.292 12l-4.6-4.6l.708-.708L14.708 12L9.4 17.308l-.708-.708z\"/></svg>",
	chevrons_right: "<svg viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path fill=\"currentColor\" d=\"m11.292 12l-4.6-4.6l.708-.708L12.708 12L7.4 17.308l-.708-.708z\"/><path fill=\"currentColor\" d=\"m17 12l-4.6-4.6l.708-.708L18.408 12l-5.308 5.308l-.708-.708z\"/></svg>",
} as const;
