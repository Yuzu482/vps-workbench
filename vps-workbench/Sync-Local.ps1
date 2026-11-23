[CmdletBinding(DefaultParameterSetName = 'Build')]
param(
    [Parameter(ParameterSetName = 'Build')][switch]$StageOnly,
    [Parameter(ParameterSetName = 'Build')][switch]$OnDemandRuntimes,
    [Parameter(ParameterSetName = 'Install', Mandatory)][string]$StagedDirectory,
    [Parameter(ParameterSetName = 'Package', Mandatory)][string]$PackageDirectory,
    [Parameter(ParameterSetName = 'Build')][string]$ElectronZip,
    [Parameter(ParameterSetName = 'Build')][string]$CompatibilityArchive,
    [Parameter(ParameterSetName = 'Build')][string]$SubscriptionArchive,
    [ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedWebRevision
)

$ErrorActionPreference = 'Stop'
$package = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'package.json') -Raw | ConvertFrom-Json
$version = [string]$package.version
if ($package.name -ne 'vps-workbench' -or $version -notmatch '^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$') {
    throw 'Unexpected VPS Workbench package metadata'
}
$install = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'VPS Workbench'))
$releases = Join-Path $install 'Releases'
$release = Join-Path $releases "VPS-Workbench-$version-win-x64"
$executableName = 'VPS Workbench.exe'

function Assert-RealDirectory([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if (!$item.PSIsContainer -or $item.FullName -ne $Path -or
        ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Unexpected release directory: $Path"
    }
}

function Read-WebRevision([string]$Directory) {
    $app = Join-Path $Directory 'resources/app'
    $web = Join-Path $app 'desktop/web'
    $metadata = Get-Content -LiteralPath (Join-Path $app 'package.json') -Raw | ConvertFrom-Json
    $manifest = Get-Content -LiteralPath (Join-Path $web 'revision.json') -Raw | ConvertFrom-Json
    if ($metadata.name -ne $package.name -or $metadata.version -ne $version -or
        $manifest.revision -cnotmatch '^[a-f0-9]{64}$' -or
        !(Test-Path -LiteralPath (Join-Path $Directory $executableName) -PathType Leaf)) {
        throw 'Staged application metadata could not be verified'
    }
    foreach ($name in @('index.html', 'renderer.js', 'markdown-worker.js', 'workbench.css', 'app-icon.png')) {
        $actual = (Get-FileHash -LiteralPath (Join-Path $web $name) -Algorithm SHA256).Hash
        if ($actual -ne $manifest.hashes.$name) { throw "UI file does not match its build manifest: $name" }
    }
    return $manifest.revision
}

function Get-LocalWorkbenchProcesses {
    foreach ($process in @(Get-Process -Name 'VPS Workbench' -ErrorAction SilentlyContinue)) {
        if ($process.HasExited) { continue }
        $path = $process.Path
        $root = $releases + [IO.Path]::DirectorySeparatorChar
        if (!$path -or !$path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
            if ($PackageDirectory -and $env:VPS_WORKBENCH_DATA_DIR) { continue }
            throw 'A VPS Workbench executable outside the local releases directory is running. Close that copy first.'
        }
        if ($path.Substring($root.Length) -notmatch '^VPS-Workbench-[A-Za-z0-9.-]+-win-x64\\VPS Workbench\.exe$') {
            throw 'Unexpected running VPS Workbench executable in the local release directory.'
        }
        $process
    }
}

$mutex = [Threading.Mutex]::new($false, 'Local\VPS.Workbench.Sync')
$locked = $false
try {
    try { $locked = $mutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $locked = $true }
    if (!$locked) { throw 'Another VPS Workbench update is running' }
    New-Item -ItemType Directory -Path $releases -Force | Out-Null
    Assert-RealDirectory $install
    Assert-RealDirectory $releases
    $stagePattern = '^\.vps-workbench-' + [regex]::Escape($version) + '-stage-[a-f0-9]{32}$'
    if ($StagedDirectory) {
        $staged = [IO.Path]::GetFullPath($StagedDirectory)
        if ((Split-Path -Parent $staged) -ne $releases -or (Split-Path -Leaf $staged) -cnotmatch $stagePattern) {
            throw 'Use the staging directory returned by Sync-Local.ps1 -StageOnly'
        }
    } elseif ($PackageDirectory) {
        $source = [IO.Path]::GetFullPath($PackageDirectory)
        Assert-RealDirectory $source
        $packageRevision = Read-WebRevision $source
        if ($ExpectedWebRevision -and $packageRevision -cne $ExpectedWebRevision) {
            throw 'The Windows update does not match its expected revision'
        }
        $unsafe = Get-ChildItem -LiteralPath $source -Force -Recurse | Where-Object {
            $_.Attributes -band [IO.FileAttributes]::ReparsePoint
        } | Select-Object -First 1
        if ($unsafe) { throw 'The Windows update contains an unexpected link' }
        $staged = Join-Path $releases ('.vps-workbench-' + $version + '-stage-' + [guid]::NewGuid().ToString('N'))
        Copy-Item -LiteralPath $source -Destination $staged -Recurse
    } else {
        $staged = Join-Path $releases ('.vps-workbench-' + $version + '-stage-' + [guid]::NewGuid().ToString('N'))
        & (Join-Path $PSScriptRoot 'Build.ps1') -OutputDirectory $staged -ElectronZip $ElectronZip `
            -CompatibilityArchive $CompatibilityArchive -SubscriptionArchive $SubscriptionArchive -OnDemandRuntimes:$OnDemandRuntimes | Out-Host
    }
    Assert-RealDirectory $staged
    $revision = Read-WebRevision $staged
    if ($ExpectedWebRevision -and $revision -cne $ExpectedWebRevision) {
        throw 'The staged UI differs from the preview revision selected for installation'
    }
    if ($StageOnly) {
        [pscustomobject]@{ StagedDirectory = $staged; Version = $version; WebRevision = $revision }
        return
    }

    if ($PackageDirectory) {
        $versionParts = $version.Split('-', 2)
        $baseVersion = [version]$versionParts[0]
        $preview = if ($versionParts.Count -gt 1 -and $versionParts[1] -match '^dev\.(\d+)$') { [int]$Matches[1] } else { [int]::MaxValue }
        foreach ($existing in Get-ChildItem -LiteralPath $releases -Directory) {
            if ($existing.Name -match '^VPS-Workbench-(\d+\.\d+\.\d+)(?:-dev\.(\d+))?-win-x64$') {
                $current = [version]$Matches[1]
                $currentPreview = if ($Matches.ContainsKey(2)) { [int]$Matches[2] } else { [int]::MaxValue }
                if ($current -gt $baseVersion -or ($current -eq $baseVersion -and $currentPreview -gt $preview)) {
                    throw 'A newer VPS Workbench is already installed'
                }
            }
        }
    }

    $previousRelease = $null
    if (Test-Path -LiteralPath $release) {
        Assert-RealDirectory $release
        $previousRelease = Join-Path $releases ('.vps-workbench-' + $version + '-previous-' + [guid]::NewGuid().ToString('N'))
    }
    $running = @(Get-LocalWorkbenchProcesses)
    $windows = @($running | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero })
    foreach ($process in $windows) { [void]$process.CloseMainWindow() }
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while (@(Get-LocalWorkbenchProcesses).Count -gt 0) {
        if ([DateTime]::UtcNow -ge $deadline) { throw "Workbench did not close. The verified build remains at $staged" }
        Start-Sleep -Milliseconds 200
    }

    if ($previousRelease) { Move-Item -LiteralPath $release -Destination $previousRelease }
    try { Move-Item -LiteralPath $staged -Destination $release }
    catch {
        if ($previousRelease -and !(Test-Path -LiteralPath $release)) {
            Move-Item -LiteralPath $previousRelease -Destination $release
        }
        throw
    }
    if ((Read-WebRevision $release) -cne $revision) { throw 'Active application files differ from the staged build' }

    $exe = Join-Path $release $executableName
    $started = Start-Process -FilePath $exe -WorkingDirectory $release -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(25)
    do {
        Start-Sleep -Milliseconds 200
        $started.Refresh()
    } while (!$started.HasExited -and $started.MainWindowHandle -eq [IntPtr]::Zero -and [DateTime]::UtcNow -lt $deadline)
    if ($started.HasExited -or $started.MainWindowHandle -eq [IntPtr]::Zero) {
        throw "VPS Workbench $version is installed at $release but its window did not become ready"
    }
    [pscustomobject]@{ Version = $version; WebRevision = $revision; Executable = $exe; ProcessId = $started.Id; PreviousRelease = $previousRelease }
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
