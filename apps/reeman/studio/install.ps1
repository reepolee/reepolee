$studio_source = $PSScriptRoot
$studio_target = Join-Path (Get-Location) "routes/studio"

if (Test-Path $studio_target) {
	throw "Studio route already exists: $studio_target"
}

Copy-Item $studio_source $studio_target -Recurse

bun reeman add-module studio
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$db_type = bun -e 'const connection_string = Bun.env.DEV_CONNECTION_STRING; if (!connection_string) { throw new Error("DEV_CONNECTION_STRING is not set"); } console.log(connection_string.toLowerCase().startsWith("mysql://") ? "mysql" : "sqlite");'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$sql_folder = Join-Path $studio_target "sql/$db_type"
$sql_files = Get-ChildItem $sql_folder -Filter "*.sql" -File
$sql_files = $sql_files | Sort-Object Name

foreach ($sql_file in $sql_files) {
	$relative_sql_path = ".\routes\studio\sql\$db_type\$($sql_file.Name)"
	bun reeman run-sql-file $relative_sql_path --force
	if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
