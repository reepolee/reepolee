export interface TypeMapper {
	to_html_input(type_string: string): string;
	to_typescript(type_string: string): string;
}
