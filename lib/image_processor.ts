// ---------------------------------------------------------------------------
// Barrel - re-exports everything from image_processor submodules
// ---------------------------------------------------------------------------

export { FORMAT_MAP, IMAGE_BUCKET, IMAGE_PREFIX, IMAGE_URL_PREFIX, MAX_ORIGINAL_DIMENSION, MAX_OUTPUT_DIMENSION } from "./image_processor/types";
export type { ProcessOptions, ProcessResult } from "./image_processor/types";

export { delete_temp_file, ensure_temp_dir, format_to_ext, format_to_mime, format_to_save_cmd, normalize_path } from "./image_processor/helpers";

export { generate_thumbnail, get_image_dims, process_image } from "./image_processor/processing";

export { process_and_save_to_s3 } from "./image_processor/storage";

export { process_image_upload, save_image_upload } from "./image_processor/adapter";
export type { ImageProcessUploadResult, ImageSaveUploadOptions, ImageSaveUploadResult } from "./image_processor/adapter";

export { cleanup, ext_of, form_int, hard_clone, mime_to_ext, normalize_filename, parse_crop, parse_resize, save_upload_to_temp } from "./image_processor/upload_helpers";
export type { Upload } from "./image_processor/upload_helpers";
