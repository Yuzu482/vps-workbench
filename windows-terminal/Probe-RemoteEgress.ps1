[CmdletBinding()]
param(
    [switch]$IAmRunningOnVps,
    [ValidateRange(1,20)][int]$Samples = 3,
    [ValidateRange(0,3600)][int]$IntervalSeconds = 5
)
$ErrorActionPreference = 'Stop'
if (-not $IAmRunningOnVps) {
    throw '请在 VPS 的 PowerShell 中运行此脚本，并添加 -IAmRunningOnVps。脚本会向 ipify 和 Cloudflare 发送 HTTPS 请求。'
}
Import-Module (Join-Path $PSScriptRoot 'EgressProbe.psm1') -Force
Write-Host '出口检查：ipify 和 Cloudflare 会看到发起请求的出口 IP。不会访问 Anthropic。'
Write-Host '这是运行本脚本的进程的采样结果，不证明 Claude、浏览器或所有目标使用相同出口。'
$proxyNames = @('HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','NO_PROXY')
$setNames = @($proxyNames | Where-Object { -not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($_)) })
if ($setNames.Count -gt 0) { Write-Host ('检测到代理环境变量（仅显示名称）：' + ($setNames -join ', ')) }
else { Write-Host '未检测到常见代理环境变量；系统代理和应用专用代理仍可能存在。' }
$result = Get-EgressDiagnostics -Samples $Samples -IntervalSeconds $IntervalSeconds
foreach ($item in $result.Summaries) {
    $description = switch ($item.State) {
        'Changed' { '采样中观察到变化' }
        'Incomplete' { '采样不完整，不能判断稳定或不可用的原因' }
        default { '本次采样未观察到变化，不能保证长期固定' }
    }
    $addresses = if ($item.Addresses.Count -gt 0) { $item.Addresses -join ', ' } else { '未取得' }
    Write-Host ("{0} / {1}: {2}/{3} 次成功；{4}；地址：{5}" -f $item.Provider, $item.Family, $item.Successful, $item.Expected, $description, $addresses)
}
foreach ($mismatch in $result.Disagreements) {
    Write-Host ("注意：第 {0} 轮的两个服务报告不同的 {1} 地址，请检查代理、路由或出口。" -f $mismatch.Round, $mismatch.Family)
}
Write-Host 'IPv6 查询失败不证明 IPv6 已禁用。请核查 Claude 及登录浏览器各自的网络路径。'
