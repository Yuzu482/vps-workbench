[CmdletBinding()]
param(
    [string]$OutputDirectory,
    [string]$ElectronZip,
    [string]$CompatibilityArchive,
    [string]$SubscriptionArchive,
    [switch]$OnDemandRuntimes
)

$ErrorActionPreference = 'Stop'
$project = $PSScriptRoot
$workspace = Split-Path -Parent $project
$application = Get-Content -LiteralPath (Join-Path $project 'package.json') -Raw | ConvertFrom-Json
$tar = Join-Path $env:SystemRoot 'System32/tar.exe'

if (!$OutputDirectory) { $OutputDirectory = Join-Path $project "dist/VPS-Workbench-$($application.version)-win-x64" }
if (!$CompatibilityArchive) {
    $CompatibilityArchive = Join-Path $workspace 'test-artifacts/dsh-account-runtime-20261120/dsh-vps-chat-workbench-0.25.2-compat.1.tgz'
}
if (!$SubscriptionArchive) {
    $SubscriptionArchive = Join-Path $workspace 'test-artifacts/dsh-claude-subscription-interaction-20261120/dsh-terminal-workbench-0.2.0-dev.14.tgz'
}
if (!$ElectronZip) {
    $cache = Join-Path $env:LOCALAPPDATA 'electron/Cache'
    if (Test-Path -LiteralPath $cache -PathType Container) {
        $cached = Get-ChildItem -LiteralPath $cache -File -Recurse -Filter 'electron-v44.7.0-win32-x64.zip' | Select-Object -First 1
        if ($cached) { $ElectronZip = $cached.FullName }
    }
}

function Resolve-PinnedFile([string]$File, [string]$ExpectedHash, [string]$Description) {
    if (!$File -or !(Test-Path -LiteralPath $File -PathType Leaf)) { throw "$Description is missing" }
    $path = (Get-Item -LiteralPath $File).FullName
    if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $ExpectedHash) {
        throw "$Description failed its SHA-256 check"
    }
    return $path
}

function Expand-VerifiedPackage([string]$File, [string]$Target) {
    $names = @(& $tar -tzf $File)
    if ($LASTEXITCODE -ne 0) { throw 'Could not list the validated package' }
    $details = @(& $tar -tvzf $File)
    if ($LASTEXITCODE -ne 0 -or $details.Count -ne $names.Count -or
        @($names | Sort-Object -Unique).Count -ne $names.Count -or
        @($details | Where-Object { !$_.StartsWith('-') }).Count -or
        @($names | Where-Object { $_ -notmatch '^package/[A-Za-z0-9._/-]+$' -or $_ -match '(?:^|/)\.{1,2}(?:/|$)' }).Count) {
        throw 'Unexpected runtime package layout'
    }
    New-Item -ItemType Directory -Path $Target | Out-Null
    & $tar -xzf $File -C $Target
    if ($LASTEXITCODE -ne 0) { throw 'Could not expand the validated package' }
}

$ElectronZip = Resolve-PinnedFile $ElectronZip 'EEE30DC8FA1F5EA95490E59F44E46EA68DD24C6E93D22FACF70FE5C2D4C2665C' 'Electron 44.7.0 win32-x64 archive'
$CompatibilityArchive = Resolve-PinnedFile $CompatibilityArchive '6C7D07292A83BD3AA8E83BCA50DE59176941F09B0F34FB9BF5DE502F622DBC9E' 'DSH 0.25.2 compatibility archive'
$SubscriptionArchive = Resolve-PinnedFile $SubscriptionArchive 'F8567DEB9211E7E676B11FD86975D2A88DC0D51CB3A4388609DDCDBB4F7EBAF0' 'Claude terminal Dev.14 archive'

if (!(Test-Path -LiteralPath (Join-Path $project 'node_modules/esbuild/lib/main.js') -PathType Leaf)) {
    throw 'Run npm ci --ignore-scripts in the VPS Workbench directory first'
}
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $output) { throw 'The distribution output directory already exists' }
$outputParent = Split-Path -Parent $output
New-Item -ItemType Directory -Path $outputParent -Force | Out-Null
$scratch = Join-Path $outputParent ('.vps-workbench-build-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null
$dist = Join-Path $scratch 'portable'
New-Item -ItemType Directory -Path $dist | Out-Null

try {
    & $tar -xf $ElectronZip -C $dist
    if ($LASTEXITCODE -ne 0) { throw 'Could not extract the Electron runtime' }
    $executable = Join-Path $dist 'VPS Workbench.exe'
    Move-Item -LiteralPath (Join-Path $dist 'electron.exe') -Destination $executable
    $assets = Join-Path $project 'assets'
    & (Join-Path $assets 'Set-WorkbenchExecutableIcon.ps1') -Executable $executable -Icon (Join-Path $assets 'workbench.ico')
    $app = Join-Path $dist 'resources/app'
    $desktop = Join-Path $app 'desktop'
    $web = Join-Path $desktop 'web'
    $helper = Join-Path $app 'helper'
    New-Item -ItemType Directory -Path $web,$helper -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $app 'extensions') -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $project 'extensions/state.mjs') -Destination (Join-Path $app 'extensions')
    New-Item -ItemType Directory -Path (Join-Path $app 'workflow-engine') -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $project 'workflow-engine/state.mjs') -Destination (Join-Path $app 'workflow-engine')
    New-Item -ItemType Directory -Path (Join-Path $app 'agent-presets') -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $project 'agent-presets/state.mjs') -Destination (Join-Path $app 'agent-presets')
    $componentMode = if ($OnDemandRuntimes) { 'on-demand' } else { 'bundled' }
    [ordered]@{name = $application.name; version = $application.version; private = $true; type = 'module'; main = 'desktop/main.mjs'; componentMode = $componentMode} |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $app 'package.json') -Encoding utf8NoBOM
    foreach ($file in @('main.mjs', 'preload.cjs', 'data.mjs', 'migrate.mjs', 'access.mjs', 'workflow-attachments.mjs')) {
        Copy-Item -LiteralPath (Join-Path $project "desktop/$file") -Destination $desktop
    }
    Copy-Item -LiteralPath (Join-Path $assets 'workbench-icon-512.png') -Destination (Join-Path $desktop 'icon.png')
    Copy-Item -LiteralPath (Join-Path $workspace 'remote-workbench/vps-chat/host/RemoteClaudeAccount.py') -Destination $desktop

    $compat = Join-Path $scratch 'compat'
    $subscription = Join-Path $scratch 'subscription'
    Expand-VerifiedPackage $CompatibilityArchive $compat
    Expand-VerifiedPackage $SubscriptionArchive $subscription
    Copy-Item -LiteralPath (Join-Path $compat 'package/helper') -Destination (Join-Path $helper 'compat') -Recurse
    $terminalSources = Join-Path $subscription 'package/ssh-prototype/bin/Debug/net10.0'
    $terminal = Join-Path $helper 'terminal'
    New-Item -ItemType Directory -Path (Join-Path $terminal 'helpers') -Force | Out-Null
    foreach ($file in @('DshSshBridge.exe', 'DshSshBridge.dll', 'DshSshBridge.deps.json', 'DshSshBridge.runtimeconfig.json',
        'RemoteSsh.Proxy.exe', 'RemoteSsh.Proxy.dll', 'RemoteSsh.Proxy.deps.json', 'RemoteSsh.Proxy.runtimeconfig.json', 'RemoteSsh.Core.dll')) {
        Copy-Item -LiteralPath (Join-Path $terminalSources $file) -Destination $terminal
    }
    foreach ($file in @('RemoteNativeSafety.py', 'RemoteNativeSession.py', 'RemoteCodexPrivacy.py', 'RemoteCodexIsolate.py',
        'sessions.py', 'remote_interactive.py')) {
        Copy-Item -LiteralPath (Join-Path $terminalSources "helpers/$file") -Destination (Join-Path $terminal 'helpers')
    }

    $windows = Join-Path $workspace 'windows-terminal'
    & dotnet publish (Join-Path $windows 'DshChatBridge/DshChatBridge.csproj') -c Release -o $helper --self-contained false --artifacts-path (Join-Path $scratch 'dotnet-chat') --nologo -v minimal -m:1
    if ($LASTEXITCODE -ne 0) { throw 'The current VPS relay-mode helper could not be built' }
    & dotnet publish (Join-Path $windows 'Proxy/Proxy.csproj') -c Release -o (Join-Path $helper 'relay') --self-contained false --artifacts-path (Join-Path $scratch 'dotnet-relay') --nologo -v minimal -m:1
    if ($LASTEXITCODE -ne 0) { throw 'The Windows relay component could not be built' }
    Copy-Item -LiteralPath (Join-Path $windows 'RemoteTaskStatus.py') -Destination $helper -Force
    $bundleArguments = @((Join-Path $project 'desktop/bundle.mjs'), $app)
    if ($OnDemandRuntimes) { $bundleArguments += '--on-demand-runtimes' }
    & node @bundleArguments
    if ($LASTEXITCODE -ne 0) { throw 'The standalone UI or server could not be built' }

    $licenses = Join-Path $dist 'third-party-notices'
    Copy-Item -LiteralPath (Join-Path $compat 'package/licenses') -Destination $licenses -Recurse
    Copy-Item -LiteralPath (Join-Path $project 'terminal/vendor/LICENSE.xterm') -Destination $licenses
    foreach ($package in @('react', 'react-dom', 'scheduler')) {
        Copy-Item -LiteralPath (Join-Path $project "node_modules/$package/LICENSE") -Destination (Join-Path $licenses "$package.txt")
    }
    foreach ($package in @('tar', '@isaacs/fs-minipass', 'chownr', 'minipass', 'minizlib', 'yallist')) {
        $notice = Get-ChildItem -LiteralPath (Join-Path $project "node_modules/$package") -Filter 'LICENSE*' -File | Select-Object -First 1
        if (!$notice) { throw "Missing license for $package" }
        Copy-Item -LiteralPath $notice.FullName -Destination (Join-Path $licenses "$($package.Replace('/', '-')).txt")
    }
    Copy-Item -LiteralPath (Join-Path $project 'README.md') -Destination (Join-Path $dist '使用说明.md')
    $requiredFiles = @('desktop/server.mjs', 'desktop/web/renderer.js', 'desktop/web/markdown-worker.js', 'desktop/RemoteClaudeAccount.py', 'client/account-player.mjs',
        'desktop/icon.png', 'desktop/web/app-icon.png', 'desktop/web/workbench.css', 'desktop/web/index.html', 'desktop/web/revision.json',
        'workflow-engine/state.mjs', 'agent-presets/state.mjs', 'desktop/workflow-attachments.mjs', 'helper/RemoteWorkflowFiles.py',
        'helper/RemoteWorkflowArtifacts.py',
        'helper/DshVpsChatBridge.exe', 'helper/relay/RemoteSsh.Proxy.exe', 'helper/compat/DshVpsChatBridge.exe',
        'helper/compat/sdk/dsh-claude-sdk-worker.mjs', 'helper/compat/antigravity/RemoteDshAntigravity.py',
        'helper/terminal/DshSshBridge.exe', 'helper/terminal/helpers/remote_interactive.py')
    $bundledFiles = @(
        'node_modules/@openai/codex-sdk/dist/index.js', 'node_modules/@openai/codex-sdk/LICENSE',
        'helper/local-codex/bin/codex.exe', 'helper/local-codex/LICENSE',
        'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs', 'node_modules/@anthropic-ai/claude-agent-sdk/LICENSE.md',
        'helper/local-claude/claude.exe', 'helper/local-claude/LICENSE.md')
    if ($OnDemandRuntimes) {
        foreach ($file in $bundledFiles) {
            if (Test-Path -LiteralPath (Join-Path $app $file)) { throw "Unexpected bundled component $file" }
        }
    } else { $requiredFiles += $bundledFiles }
    foreach ($path in @('helper','helper/compat','helper/compat/sdk','helper/compat/antigravity')) {
        $requiredFiles += @('DshVpsChatBridge.exe','DshVpsChatBridge.dll','DshVpsChatBridge.deps.json',
            'DshVpsChatBridge.runtimeconfig.json','RemoteSsh.Core.dll') | ForEach-Object { "$path/$_" }
    }
    foreach ($required in $requiredFiles) {
        if (!(Test-Path -LiteralPath (Join-Path $app $required) -PathType Leaf)) { throw "Distribution file missing $required" }
    }
    $from = Get-Item -LiteralPath $dist
    if ($from.FullName -ne $dist -or $from.Parent.FullName -ne $scratch -or
        (Split-Path -Parent $scratch) -ne $outputParent -or (Test-Path -LiteralPath $output) -or
        ($from.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Unexpected distribution destination'
    }
    Move-Item -LiteralPath $dist -Destination $output
    Join-Path $output 'VPS Workbench.exe'
} finally {
    $item = Get-Item -LiteralPath $scratch -Force
    if ($item.FullName -eq $scratch -and $item.Parent.FullName -eq $outputParent -and
        $item.Name -match '^\.vps-workbench-build-[a-f0-9]{32}$' -and
        !($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        Remove-Item -LiteralPath $item.FullName -Recurse -Force
    }
}
