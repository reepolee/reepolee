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
	push_pin: "<svg viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path fill=\"currentColor\" fill-rule=\"evenodd\" d=\"M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1l1-1v-7H19v-2c-1.66 0-3-1.34-3-3\"/></svg>",
	pin_off: "<svg viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path fill=\"currentColor\" d=\"m9 9l7 7h-3v4l-1 3l-1-3v-4H6v-3l3-3zm8-7v2l-2 1v5l3 3v2.461L12.27 9.73L9 6.46V5L7 4V2z\"/><path fill=\"currentColor\" d=\"M2.27 2.27L1 3.54L20.46 23l1.27-1.27L11 11z\"/></svg>",
} as const;
