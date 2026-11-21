[CmdletBinding()]
param([switch]$Demo, [switch]$CheckOnly, [switch]$ManagedLinux, [switch]$ManagerGui)
$ErrorActionPreference = 'Stop'
if ($Demo -and $CheckOnly) { throw 'Choose either -Demo or -CheckOnly.' }
if ($ManagedLinux -and ($Demo -or $CheckOnly)) { throw '-ManagedLinux requires the full automated test.' }
if ($ManagerGui -and -not $ManagedLinux) { throw '-ManagerGui requires -ManagedLinux.' }
& (Join-Path $PSScriptRoot 'Build.ps1')
$projects = @('Tests\Tests.csproj','TestHarness\TestHarness.csproj','TestFixture\TestFixture.csproj')
if ($ManagedLinux) { $projects += 'ManagedTaskHarness\ManagedTaskHarness.csproj' }
if ($ManagerGui) { $projects += 'ManagerGuiTests\ManagerGuiTests.csproj'; $projects += 'ChatGuiTests\ChatGuiTests.csproj' }
foreach ($project in $projects) {
    & dotnet build (Join-Path $PSScriptRoot $project) -c Release -v minimal -m:1 /p:UseSharedCompilation=false
    if ($LASTEXITCODE -ne 0) { throw "Build failed: $project" }
}
$configurationLog = Join-Path $PSScriptRoot 'artifacts\configuration-tests.log'
$priorErrorAction = $ErrorActionPreference
try {
    # Windows PowerShell represents redirected native stderr as ErrorRecords.
    # Collect it before checking the exit code so the precise failure is retained.
    $ErrorActionPreference = 'Continue'
    & (Join-Path $PSScriptRoot 'Tests\bin\Release\net10.0-windows\Tests.exe') 2>&1 | Tee-Object -FilePath $configurationLog
    $configurationExitCode = $LASTEXITCODE
} finally { $ErrorActionPreference = $priorErrorAction }
if ($null -eq $configurationExitCode -or $configurationExitCode -ne 0) {
    throw "Configuration tests failed (exit $configurationExitCode). Details: $configurationLog"
}
& (Join-Path $PSScriptRoot 'Tests\EgressProbe.test.ps1')
if ($CheckOnly) { Write-Output 'PASS: prelaunch checks completed; no SSH server or GUI started.'; return }
$python = Join-Path (Split-Path $PSScriptRoot -Parent) '.venv-ssh-loopback\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) { throw 'The local SSH test requires the project Python environment with paramiko==5.1.0.' }
$env:PYTHONIOENCODING = 'utf-8'
foreach ($pattern in @('test_remote_egress.py', 'test_remote_task_start.py', 'test_remote_task_status.py', 'test_remote_codex_privacy.py', 'test_socks_bridge.py')) {
    & $python -B -m unittest discover -s (Join-Path $PSScriptRoot 'Tests') -p $pattern -q
    if ($LASTEXITCODE -ne 0) { throw "Python tests failed: $pattern" }
}
$testFile = if ($Demo) { 'Tests\demo.py' } else { 'Tests\loopback.py' }
& $python -u (Join-Path $PSScriptRoot $testFile)
if ($LASTEXITCODE -ne 0) { throw 'SSH test/demo failed. Review output above.' }
if ($ManagedLinux) {
    & $python -u (Join-Path $PSScriptRoot 'Tests\remote_task_wsl.py')
    if ($LASTEXITCODE -ne 0) { throw 'WSL remote task lifecycle tests failed. Review output above.' }
    & $python -u (Join-Path $PSScriptRoot 'Tests\managed_loopback_wsl.py')
    if ($LASTEXITCODE -ne 0) { throw 'Managed task WSL loopback failed. Review output above.' }
    & $python -u (Join-Path $PSScriptRoot 'Tests\source_isolation_wsl.py')
    if ($LASTEXITCODE -ne 0) { throw 'WSL source isolation checks failed. Review output above.' }
    & $python -u (Join-Path $PSScriptRoot 'Tests\codex_isolation_wsl.py')
    if ($LASTEXITCODE -ne 0) { throw 'WSL isolated Codex checks failed. Review output above.' }
}
if ($ManagerGui) {
    $artifactRoot = Join-Path (Split-Path $PSScriptRoot -Parent) 'test-artifacts'
    if (-not (Test-Path -LiteralPath $artifactRoot -PathType Container)) { New-Item -ItemType Directory -Path $artifactRoot | Out-Null }
    $fixtureDir = Join-Path $artifactRoot ('manager-gui-auto-' + [Guid]::NewGuid().ToString('N'))
    & $python -u (Join-Path $PSScriptRoot 'Tests\manager_gui_fixture.py') $fixtureDir --run-start
    if ($LASTEXITCODE -ne 0) { throw 'Manager GUI component test failed. Review output and any retained fixture state.' }
    Write-Output "GUI test evidence: $fixtureDir"
    $chatFixtureDir = Join-Path $artifactRoot ('chat-ssh-loopback-' + [Guid]::NewGuid().ToString('N'))
    & $python -u (Join-Path $PSScriptRoot 'Tests\chat_gui_loopback.py') $chatFixtureDir
    if ($LASTEXITCODE -ne 0) { throw 'Chat GUI loopback failed. Review output and any retained fixture state.' }
    Write-Output "Chat GUI test evidence: $chatFixtureDir"
}
