[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$destination = Join-Path $PSScriptRoot 'artifacts\app'
foreach ($project in @('Console\Console.csproj', 'Manager\Manager.csproj', 'Proxy\Proxy.csproj')) {
    & dotnet publish (Join-Path $PSScriptRoot $project) -c Release -o $destination --self-contained false --nologo -v minimal -m:1
    if ($LASTEXITCODE -ne 0) { throw "Build failed: $project" }
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'README.md') -Destination (Join-Path $destination 'README.md')
foreach ($file in @('Probe-RemoteEgress.ps1','EgressProbe.psm1','Probe-RemoteEgress.py','RemoteCodexPrivacy.py','RemoteCodexIsolate.py','RemoteNativeSafety.py','RemoteNativeSession.py','RemoteChatFiles.py','RemoteClaudeShared.py','RemoteClaudeAuth.py','RemoteTask.py','RemoteTaskStart.py','RemoteTaskStatus.py')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination (Join-Path $destination $file)
}
if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'VALIDATION.md')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'VALIDATION.md') -Destination (Join-Path $destination 'VALIDATION.md')
}
Write-Output "Ready: $destination\RemoteSsh.Manager.exe"
