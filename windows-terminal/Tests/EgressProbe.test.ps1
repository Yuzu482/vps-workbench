$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot '..\EgressProbe.psm1') -Force
function Assert([bool]$condition, [string]$message) { if (-not $condition) { throw $message } }
Assert ((ConvertTo-EgressAddress ' 203.0.113.10 ' 'IPv4') -eq '203.0.113.10') 'IPv4 parser'
Assert ($null -eq (ConvertTo-EgressAddress '2001:db8::1' 'IPv4')) 'family mismatch'
Assert ($null -eq (ConvertTo-EgressAddress '<html>bad</html>' 'IPv4')) 'invalid response'
$stable = Get-EgressDiagnostics -Samples 2 -IntervalSeconds 0 -Request {
    param($url, $family, $round)
    if ($family -eq 'IPv4') { '203.0.113.1' } else { '2001:db8::1' }
}
Assert (@($stable.Summaries | Where-Object State -eq 'UnchangedInSamples').Count -eq 4) 'stable samples'
Assert ($stable.Disagreements.Count -eq 0) 'no disagreement'
$changed = Get-EgressDiagnostics -Samples 2 -IntervalSeconds 0 -Request {
    param($url, $family, $round)
    if ($family -eq 'IPv6') { throw 'not available' }
    if ($url -like '*ipify*' -and $round -eq 2) { '203.0.113.2' } else { '203.0.113.1' }
}
Assert (@($changed.Summaries | Where-Object { $_.Provider -eq 'ipify' -and $_.Family -eq 'IPv4' -and $_.State -eq 'Changed' }).Count -eq 1) 'change detected'
Assert (@($changed.Summaries | Where-Object { $_.Family -eq 'IPv6' -and $_.State -eq 'Incomplete' }).Count -eq 2) 'failure remains inconclusive'
Assert ($changed.Disagreements.Count -eq 1) 'provider mismatch'
try { & (Join-Path $PSScriptRoot '..\Probe-RemoteEgress.ps1'); throw 'confirmation guard was bypassed' }
catch { Assert ($_.Exception.Message -match 'IAmRunningOnVps') 'script guard' }
Write-Output 'PASS: egress parsing, sample change, incomplete results, provider mismatch and VPS guard; no network requests'
