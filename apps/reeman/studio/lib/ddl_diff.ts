import { diff_lines, type Line_diff_line } from "$lib/line_diff";

export type DdlDiffLineKind = Line_diff_line["kind"];
export type DdlDiffLine = Line_diff_line;

/** Diff two DDL texts line by line, returning same/add/remove runs in display order. */
export const diff_ddl_lines = diff_lines;
