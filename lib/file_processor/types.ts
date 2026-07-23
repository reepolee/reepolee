// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FILE_BUCKET = Bun.env.S3_FILE_BUCKET || "files";
const FILE_URL_PREFIX = `/${FILE_BUCKET}`;
const FILE_PREFIX = "";

// Maximum allowed upload size in bytes.
const MAX_FILE_SIZE = 25 * 1024 * 1024;

// Supported document extensions and their MIME types.
const ALLOWED_MIME_TYPES: Record<string, { mime: string; ext: string; }> = {
	pdf: { mime: "application/pdf", ext: ".pdf" },
	doc: { mime: "application/msword", ext: ".doc" },
	docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: ".docx" },
	xls: { mime: "application/vnd.ms-excel", ext: ".xls" },
	xlsx: { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: ".xlsx" },
	ppt: { mime: "application/vnd.ms-powerpoint", ext: ".ppt" },
	pptx: { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ext: ".pptx" },
	txt: { mime: "text/plain", ext: ".txt" },
	csv: { mime: "text/csv", ext: ".csv" },
	zip: { mime: "application/zip", ext: ".zip" },
};

export { ALLOWED_MIME_TYPES, FILE_BUCKET, FILE_PREFIX, FILE_URL_PREFIX, MAX_FILE_SIZE };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SaveFileOptions = {
	folder?: string;
	s3_key?: string;
	s3_prefix?: string;
};

export type SaveFileResult = {
	filename: string;
	mime: string;
	file_size: number;
	s3_key?: string;
	s3_url?: string;
};
