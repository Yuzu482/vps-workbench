Set-StrictMode -Version Latest

function ConvertTo-EgressAddress {
    param([AllowNull()][string]$Text, [ValidateSet('IPv4','IPv6')][string]$Family)
    if ($null -eq $Text -or $Text.Length -gt 100) { return $null }
    $value = $Text.Trim()
    $address = $null
    if (-not [System.Net.IPAddress]::TryParse($value, [ref]$address)) { return $null }
    $expected = if ($Family -eq 'IPv4') { [System.Net.Sockets.AddressFamily]::InterNetwork } else { [System.Net.Sockets.AddressFamily]::InterNetworkV6 }
    if ($address.AddressFamily -ne $expected -or $value.Contains('%')) { return $null }
    return $address.ToString()
}

function Get-EgressDiagnostics {
    [CmdletBinding()]
    param(
        [ValidateRange(1,20)][int]$Samples = 3,
        [ValidateRange(0,3600)][int]$IntervalSeconds = 5,
        [scriptblock]$Request = {
            param($url, $family, $round)
            # Windows PowerShell 5.1 and PowerShell 7 both accept this form.
            # Never emit response/error details, which could include proxy data.
            (Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 8 -MaximumRedirection 0 -ErrorAction Stop).Content
        }
    )
    $endpoints = @(
        [pscustomobject]@{ Name='ipify'; Family='IPv4'; Url='https://api.ipify.org/' },
        [pscustomobject]@{ Name='Cloudflare'; Family='IPv4'; Url='https://ipv4.icanhazip.com/' },
        [pscustomobject]@{ Name='ipify'; Family='IPv6'; Url='https://api6.ipify.org/' },
        [pscustomobject]@{ Name='Cloudflare'; Family='IPv6'; Url='https://ipv6.icanhazip.com/' }
    )
    $observations = [System.Collections.Generic.List[object]]::new()
    for ($round = 1; $round -le $Samples; $round++) {
        if ($round -gt 1 -and $IntervalSeconds -gt 0) { Start-Sleep -Seconds $IntervalSeconds }
        foreach ($endpoint in $endpoints) {
            Write-Progress -Activity '正在采样出口 IP' -Status ("第 {0}/{1} 轮：{2} {3}" -f $round, $Samples, $endpoint.Name, $endpoint.Family)
            $address = $null
            try {
                $response = & $Request $endpoint.Url $endpoint.Family $round
                if ($response -is [string]) { $address = ConvertTo-EgressAddress -Text $response -Family $endpoint.Family }
            } catch { $address = $null }
            $observations.Add([pscustomobject]@{ Round=$round; Provider=$endpoint.Name; Family=$endpoint.Family; Address=$address })
        }
    }
    Write-Progress -Activity '正在采样出口 IP' -Completed
    $summaries = foreach ($endpoint in $endpoints) {
        $entries = @($observations | Where-Object { $_.Provider -eq $endpoint.Name -and $_.Family -eq $endpoint.Family })
        $addresses = @($entries | Where-Object { $null -ne $_.Address } | ForEach-Object { $_.Address } | Select-Object -Unique)
        $successful = @($entries | Where-Object { $null -ne $_.Address }).Count
        $state = if ($addresses.Count -gt 1) { 'Changed' } elseif ($successful -lt $Samples) { 'Incomplete' } else { 'UnchangedInSamples' }
        [pscustomobject]@{ Provider=$endpoint.Name; Family=$endpoint.Family; State=$state; Successful=$successful; Expected=$Samples; Addresses=$addresses }
    }
    $disagreements = foreach ($family in @('IPv4','IPv6')) {
        for ($round = 1; $round -le $Samples; $round++) {
            $values = @($observations | Where-Object { $_.Family -eq $family -and $_.Round -eq $round -and $null -ne $_.Address } | ForEach-Object { $_.Address } | Select-Object -Unique)
            if ($values.Count -gt 1) { [pscustomobject]@{ Family=$family; Round=$round } }
        }
    }
    [pscustomobject]@{ Observations=@($observations.ToArray()); Summaries=@($summaries); Disagreements=@($disagreements) }
}

Export-ModuleMember -Function ConvertTo-EgressAddress, Get-EgressDiagnostics
