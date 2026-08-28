#!/usr/bin/env sh

set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
studio_target="$(pwd)/routes/studio"

if [ -e "$studio_target" ]; then
	echo "Studio route already exists: $studio_target" >&2
	exit 1
fi

cp -R "$script_dir" "$studio_target"

bun reeman add-module studio

db_type="$(bun -e 'const connection_string = Bun.env.DEV_CONNECTION_STRING; if (!connection_string) { throw new Error("DEV_CONNECTION_STRING is not set"); } console.log(connection_string.toLowerCase().startsWith("mysql://") ? "mysql" : "sqlite");')"
sql_folder="$studio_target/sql/$db_type"
sql_files_found=false

for sql_file in "$sql_folder"/*.sql; do
	if [ ! -f "$sql_file" ]; then
		continue
	fi

	sql_files_found=true
	sql_name="$(basename -- "$sql_file")"
	bun reeman run-sql-file "./routes/studio/sql/$db_type/$sql_name" --force
done

if [ "$sql_files_found" = false ]; then
	echo "No Studio SQL files found in: $sql_folder" >&2
	exit 1
fi
