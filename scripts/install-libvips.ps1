# install-libvips.ps1
# Robust libvips installer for Windows (x64)

$ErrorActionPreference = "Stop"

# --------------------------------------------------
# CONFIG
# --------------------------------------------------

$installDir = "C:\libvips"
$tempDir = Join-Path $env:TEMP "libvips-install"

# --------------------------------------------------
# PREP
# --------------------------------------------------

Write-Host "Preparing folders..."

Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $tempDir | Out-Null
New-Item -ItemType Directory -Path $installDir -Force | Out-Null

# --------------------------------------------------
# FETCH RELEASE
# --------------------------------------------------

Write-Host "Fetching latest libvips release..."

$release = Invoke-RestMethod `
  -Uri "https://api.github.com/repos/libvips/build-win64-mxe/releases/latest" `
  -Headers @{ "User-Agent" = "PowerShell-libvips-installer" }

# --------------------------------------------------
# FILTER x64 ASSETS
# --------------------------------------------------

$assets = $release.assets | Where-Object {
    $_.name -match "x64" -and $_.name -match "\.zip$"
}

if (-not $assets) {
    Write-Host "No x64 assets found. Available:"
    $release.assets | ForEach-Object { Write-Host " - $($_.name)" }
    throw "Failed to locate x64 libvips packages."
}

# --------------------------------------------------
# SELECT BEST PACKAGE
# priority: all > web > fallback
# --------------------------------------------------

$asset =
    ($assets | Where-Object { $_.name -match "all" } | Select-Object -First 1)

if (-not $asset) {
    $asset =
        ($assets | Where-Object { $_.name -match "web$" } | Select-Object -First 1)
}

if (-not $asset) {
    $asset = $assets | Select-Object -First 1
}

if (-not $asset) {
    throw "No suitable libvips x64 package found."
}

Write-Host "Selected package: $($asset.name)"

# --------------------------------------------------
# DOWNLOAD
# --------------------------------------------------

$zipPath = Join-Path $tempDir $asset.name

Write-Host "Downloading..."

Invoke-WebRequest `
    -Uri $asset.browser_download_url `
    -OutFile $zipPath

# --------------------------------------------------
# EXTRACT
# --------------------------------------------------

Write-Host "Extracting..."

Expand-Archive `
    -Path $zipPath `
    -DestinationPath $installDir `
    -Force

# --------------------------------------------------
# FIND vips.exe
# --------------------------------------------------

Write-Host "Locating vips.exe..."

$binPath = Get-ChildItem $installDir -Recurse -File -Filter "vips.exe" |
    Select-Object -First 1 |
    Split-Path -Parent

if (-not $binPath) {
    throw "vips.exe not found after extraction."
}

Write-Host "Found bin directory: $binPath"

# --------------------------------------------------
# ADD TO USER PATH (no admin required)
# --------------------------------------------------

Write-Host "Updating USER PATH..."

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")

if ($userPath -notlike "*$binPath*") {
    [Environment]::SetEnvironmentVariable(
        "Path",
        "$userPath;$binPath",
        "User"
    )
    Write-Host "User PATH updated."
} else {
    Write-Host "Already in User PATH."
}
# --------------------------------------------------
# DONE
# --------------------------------------------------

Write-Host ""
Write-Host "✔ libvips installation complete"
Write-Host "✔ Binary path: $binPath"
Write-Host ""
Write-Host "Restart terminal then run:"
Write-Host "  vips --version"
