import { get_cookie } from "$lib/cookies";
import { get_lang_from_request, localized_url } from "$lib/route";
import { get_table_name_from_dir } from "$lib/helpers";
__import.conditional_helpers____import.crud_routes____import.pagination__
__route.param_imports__import { get_global_scopes, get_scope_clause } from "$lib/global_scopes";
import { enrich_filter_definitions, get_filter_definitions, resolve_filters } from "$lib/table_filters";
import { render, render_to_string } from "$lib/render";
import { create_ctx } from "$lib/request_context";

import { get_record_by_id, create_record, update_record, delete_record, search_records__nested.import__, TABLE_NAME } from "./sql";
__import.ree_icon__import { cache } from "$lib/cache";
__import.view__
import { default_language } from "$config/supported_languages";
import { strip_api_sensitive } from "$config/api_blocklist";
import { sql_log } from "$lib/logger";
__import.bun__

import { validate, validate_touched } from "./schema/validation_server";
import { columns, enable_delete, fields } from "./schema/table";

__import.select_functions__
__import.tags__
