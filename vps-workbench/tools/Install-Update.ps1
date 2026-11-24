[CmdletBinding()]
param([string]$BaseDirectory)

$ErrorActionPreference = 'Stop'
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'update.json') -Raw | ConvertFrom-Json
$targetPackage = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'package.json') -Raw | ConvertFrom-Json
if ($manifest.version -notmatch '^\d+\.\d+\.\d+-dev\.\d+$' -or $manifest.webRevision -cnotmatch '^[0-9a-f]{64}$' -or
    !$manifest.files.Count -or !$manifest.bases.Count -or $targetPackage.name -ne 'vps-workbench' -or
    $targetPackage.version -ne $manifest.version) { throw 'Invalid update manifest.' }
$releases = Join-Path $env:LOCALAPPDATA 'VPS Workbench/Releases'
$installedPackage = Join-Path $releases "VPS-Workbench-$($manifest.version)-win-x64/resources/app/package.json"
if (Test-Path -LiteralPath $installedPackage -PathType Leaf) {
    $installed = Get-Content -LiteralPath $installedPackage -Raw | ConvertFrom-Json
    if ([bool]$installed.personalClaudeSubscription -ne [bool]$targetPackage.personalClaudeSubscription) {
        throw 'The installed edition differs from this update. Use an update for the installed edition.'
    }
}

function Test-UpdateBase([string]$Directory) {
    try {
        $app = Join-Path $Directory 'resources/app'
        $package = Get-Content -LiteralPath (Join-Path $app 'package.json') -Raw | ConvertFrom-Json
        $web = Get-Content -LiteralPath (Join-Path $app 'desktop/web/revision.json') -Raw | ConvertFrom-Json
        if ($package.name -ne 'vps-workbench' -or
            [bool]$package.personalClaudeSubscription -ne [bool]$targetPackage.personalClaudeSubscription -or
            !(Test-Path -LiteralPath (Join-Path $Directory 'VPS Workbench.exe') -PathType Leaf)) {
            return $false
        }
        return [bool]($manifest.bases | Where-Object { $_.version -eq $package.version -and $_.revision -ceq $web.revision })
    } catch { return $false }
}

if (!$BaseDirectory) {
    foreach ($base in $manifest.bases) {
        $installed = Join-Path $releases "VPS-Workbench-$($base.version)-win-x64"
        if ((Test-Path -LiteralPath $installed -PathType Container) -and (Test-UpdateBase $installed)) {
            $BaseDirectory = $installed
            break
        }
    }
}
if (!$BaseDirectory) {
    $BaseDirectory = (Read-Host 'Enter the extracted old Workbench folder (or drag that folder here)').Trim('"')
}
if (!$BaseDirectory -or !(Test-UpdateBase $BaseDirectory)) {
    throw 'This update needs a supported existing Windows x64 Workbench installation. See the release notes.'
}
$base = (Resolve-Path -LiteralPath $BaseDirectory).Path
$payload = Join-Path $PSScriptRoot 'Payload'
$scratch = Join-Path ([IO.Path]::GetFullPath([IO.Path]::GetTempPath())) ('VPS-Workbench-update-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null
try {
    $seen = @{}
    Write-Host 'Preparing and checking the update. The previous version will be kept.'
    foreach ($entry in $manifest.files) {
        $relative = [string]$entry.path
        if ($relative -cnotmatch '^[\w][\w@./ -]*$' -or $relative -match '[. ](/|$)|//|/\.' -or
            $seen.ContainsKey($relative) -or $entry.sha256 -cnotmatch '^[0-9a-f]{64}$' -or $entry.changed -isnot [bool]) {
            throw 'The update contains an invalid file record.'
        }
        $seen[$relative] = $true
        $source = Join-Path $(if ($entry.changed) { $payload } else { $base }) $relative
        $destination = Join-Path $scratch $relative
        $parent = Split-Path -Parent $destination
        if (!(Test-Path -LiteralPath $source -PathType Leaf)) { throw "Required update file is missing: $relative" }
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
        Copy-Item -LiteralPath $source -Destination $destination
        if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $entry.sha256) {
            throw "File verification failed: $relative. Use an unmodified supported base and re-extract the update."
        }
    }
    $result = & (Join-Path $PSScriptRoot 'Sync-Local.ps1') -PackageDirectory $scratch -ExpectedWebRevision $manifest.webRevision
    if (!$result.Executable) { throw 'The updater could not confirm the new application.' }
    try {
        $programs = Join-Path $env:APPDATA 'Microsoft/Windows/Start Menu/Programs'
        New-Item -ItemType Directory -Path $programs -Force | Out-Null
        $shell = New-Object -ComObject WScript.Shell
        $link = $shell.CreateShortcut((Join-Path $programs 'VPS Workbench.lnk'))
        $link.TargetPath = $result.Executable
        $link.WorkingDirectory = Split-Path -Parent $result.Executable
        $link.Save()
    } catch { Write-Warning 'The application is ready, but the Start menu shortcut could not be updated.' }
    $result
} finally {
    if ((Split-Path -Leaf $scratch) -cmatch '^VPS-Workbench-update-[a-f0-9]{32}$' -and (Test-Path -LiteralPath $scratch)) {
        Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
    }
}
