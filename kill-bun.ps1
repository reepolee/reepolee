$bun_processes = Get-Process -Name "bun" -ErrorAction SilentlyContinue

if (-not $bun_processes) {
    Write-Host "No running Bun processes found."
    exit 0
}

$bun_processes | ForEach-Object {
    Write-Host "Killing Bun process (PID: $($_.Id))"
    Stop-Process -Id $_.Id -Force -Confirm:$false
}

Write-Host "Done."
