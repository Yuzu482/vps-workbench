[CmdletBinding()]
param([string]$PrebuiltHelperDirectory)

$ErrorActionPreference = 'Stop'
$outputDirectory = Join-Path $PSScriptRoot 'dist'
$windowsTerminal = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../windows-terminal'))
$bridgeProject = Join-Path $windowsTerminal 'DshChatBridge/DshChatBridge.csproj'
$relayProject = Join-Path $windowsTerminal 'Proxy/Proxy.csproj'
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$buildRoot = Join-Path $tempRoot ('dsh-vps-chat-package-' + [Guid]::NewGuid().ToString('N'))
$stage = Join-Path $buildRoot 'package'

New-Item -ItemType Directory -Path $outputDirectory, $stage -Force | Out-Null
try {
    $helperDirectory = Join-Path $stage 'helper'
    if ($PrebuiltHelperDirectory) {
        New-Item -ItemType Directory -Path $helperDirectory | Out-Null
        $helperFiles = @(
            'DshVpsChatBridge.exe', 'DshVpsChatBridge.dll', 'DshVpsChatBridge.deps.json', 'DshVpsChatBridge.runtimeconfig.json',
            'RemoteSsh.Core.dll', 'RemoteTask.py', 'RemoteTaskStart.py',
            'RemoteCodexPrivacy.py', 'RemoteCodexIsolate.py', 'RemoteDshCodexStream.py', 'RemoteDshCodexCatalog.py'
        )
        foreach ($file in $helperFiles) {
            Copy-Item -LiteralPath (Join-Path $PrebuiltHelperDirectory $file) -Destination $helperDirectory
        }
        $antigravity = Join-Path $PrebuiltHelperDirectory 'RemoteDshAntigravity.py'
        if (Test-Path -LiteralPath $antigravity -PathType Leaf) {
            Copy-Item -LiteralPath $antigravity -Destination $helperDirectory
        }
        $sdkFiles = @('dsh-claude-sdk-worker.mjs', 'RemoteDshClaudeSdk.py', 'RemoteNativeSafety.py', 'RemoteNativeSession.py', 'sessions.py')
        if (!($sdkFiles | Where-Object { !(Test-Path -LiteralPath (Join-Path $PrebuiltHelperDirectory $_) -PathType Leaf) })) {
            foreach ($file in $sdkFiles) {
                Copy-Item -LiteralPath (Join-Path $PrebuiltHelperDirectory $file) -Destination $helperDirectory
            }
        }
    } else {
        $publishArgs = @(
            'publish', $bridgeProject, '-c', 'Release', '-o', $helperDirectory,
            '--self-contained', 'false', '--artifacts-path', (Join-Path $buildRoot 'dotnet'),
            '--nologo', '-v', 'minimal', '-m:1'
        )
        & dotnet @publishArgs
        if ($LASTEXITCODE -ne 0) { throw 'The VPS Chat helper build failed.' }
    }
    Copy-Item -LiteralPath (Join-Path $windowsTerminal 'RemoteTaskStatus.py') -Destination $helperDirectory -Force

    $relayPublish = Join-Path $buildRoot 'relay'
    $relayArguments = @(
        'publish', $relayProject, '-c', 'Release', '-o', $relayPublish,
        '--self-contained', 'false', '--artifacts-path', (Join-Path $buildRoot 'dotnet-relay'),
        '--nologo', '-v', 'minimal', '-m:1'
    )
    & dotnet @relayArguments
    if ($LASTEXITCODE -ne 0) { throw 'The Windows SSH relay build failed.' }
    $relayDirectory = New-Item -ItemType Directory -Path (Join-Path $helperDirectory 'relay')
    foreach ($file in @('RemoteSsh.Proxy.exe', 'RemoteSsh.Proxy.dll', 'RemoteSsh.Proxy.deps.json', 'RemoteSsh.Proxy.runtimeconfig.json', 'RemoteSsh.Core.dll')) {
        Copy-Item -LiteralPath (Join-Path $relayPublish $file) -Destination $relayDirectory.FullName
    }

    foreach ($entry in @('package.json', 'cordis.patch.yml', 'README.md', 'host/RemoteClaudeAccount.py')) {
        $target = Join-Path $stage $entry
        New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $entry) -Destination $target
    }

    $clientPath = Join-Path $stage 'client/client.js'
    Push-Location -LiteralPath $PSScriptRoot
    try {
        $clientPackages = @('esbuild', 'marked', 'entities', 'parse5', '@novnc/novnc', 'ws')
        if ($clientPackages | Where-Object { -not (Test-Path -LiteralPath "node_modules/$_/package.json") }) {
            throw 'Run npm ci --ignore-scripts in the VPS Chat package before building.'
        }
        & npm exec --offline -- esbuild client/client.js --bundle --platform=browser --format=iife `
            --charset=utf8 --legal-comments=inline --loader:.png=dataurl "--outfile=$clientPath"
        if ($LASTEXITCODE -ne 0) { throw 'The VPS Chat client build failed.' }
        $playerPath = Join-Path $stage 'client/account-player.mjs'
        & node node_modules/esbuild/bin/esbuild node_modules/@novnc/novnc/core/rfb.js --bundle `
            --platform=browser --format=esm --charset=utf8 --legal-comments=inline "--outfile=$playerPath"
        if ($LASTEXITCODE -ne 0) { throw 'The VPS account viewer build failed.' }
        $hostPath = Join-Path $stage 'host/index.js'
        $nodeRequire = 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);'
        & node node_modules/esbuild/bin/esbuild host/index.js --bundle --platform=node --format=esm `
            --legal-comments=inline "--banner:js=$nodeRequire" "--outfile=$hostPath"
        if ($LASTEXITCODE -ne 0) { throw 'The VPS Chat host build failed.' }
        $licenses = (New-Item -Path (Join-Path $stage 'licenses') -ItemType Directory).FullName
        foreach ($package in @('marked', 'entities', 'parse5')) {
            Copy-Item -LiteralPath "node_modules/$package/LICENSE" -Destination (Join-Path $licenses "$package.txt")
        }
        Copy-Item -LiteralPath 'node_modules/parse5/node_modules/entities/LICENSE' -Destination (Join-Path $licenses 'parse5-entities.txt')
        foreach ($license in @('LICENSE.MPL-2.0', 'LICENSE.BSD-2-Clause', 'LICENSE.BSD-3-Clause')) {
            Copy-Item -LiteralPath "node_modules/@novnc/novnc/docs/$license" -Destination (Join-Path $licenses "noVNC-$license")
        }
        Copy-Item -LiteralPath 'node_modules/@novnc/novnc/vendor/pako/LICENSE' -Destination (Join-Path $licenses 'pako.txt')
        Copy-Item -LiteralPath 'node_modules/ws/LICENSE' -Destination (Join-Path $licenses 'ws.txt')
    } finally {
        Pop-Location
    }

    & npm pack $stage --pack-destination $outputDirectory --ignore-scripts --offline
    if ($LASTEXITCODE -ne 0) { throw 'The DSH package build failed.' }
} finally {
    $buildItem = Get-Item -LiteralPath $buildRoot
    if ($buildItem.Parent.FullName.TrimEnd('\', '/') -eq $tempRoot.TrimEnd('\', '/') -and
        $buildItem.Name -match '^dsh-vps-chat-package-[a-f0-9]{32}$' -and
        -not ($buildItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        Remove-Item -LiteralPath $buildItem.FullName -Recurse -Force
    }
}
