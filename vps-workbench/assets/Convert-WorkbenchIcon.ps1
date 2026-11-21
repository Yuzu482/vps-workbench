[CmdletBinding()]
param(
    [string]$Source = (Join-Path $PSScriptRoot 'workbench-mark.png'),
    [Parameter(Mandatory)][string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$destination = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $destination -Force | Out-Null

function ConvertTo-PngFrame([System.Drawing.Image]$Image, [int]$Size) {
    $frame = [System.Drawing.Bitmap]::new($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
        $graphics = [System.Drawing.Graphics]::FromImage($frame)
        try {
            $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
            $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
            $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $graphics.Clear([System.Drawing.Color]::Transparent)
            $graphics.DrawImage($Image, 0, 0, $Size, $Size)
        } finally {
            $graphics.Dispose()
        }
        $bytes = [IO.MemoryStream]::new()
        try {
            $frame.Save($bytes, [System.Drawing.Imaging.ImageFormat]::Png)
            return ,$bytes.ToArray()
        } finally {
            $bytes.Dispose()
        }
    } finally {
        $frame.Dispose()
    }
}

$image = [System.Drawing.Bitmap]::FromFile((Get-Item -LiteralPath $Source).FullName)
try {
    if ($image.Width -ne $image.Height -or $image.Width -lt 512 -or $image.GetPixel(0, 0).A -ne 0) {
        throw 'The workbench icon master must be square, at least 512px, and have transparent corners.'
    }
    $sizes = @(16, 20, 24, 32, 40, 48, 64, 96, 128, 256)
    $frames = @(foreach ($size in $sizes) {
        [pscustomobject]@{ Size = $size; Bytes = [byte[]](ConvertTo-PngFrame $image $size) }
    })
    $large = [byte[]](ConvertTo-PngFrame $image 512)
} finally {
    $image.Dispose()
}

$png512 = Join-Path $destination 'workbench-icon-512.png'
$png64 = Join-Path $destination 'workbench-icon-64.png'
$ico = Join-Path $destination 'workbench.ico'
foreach ($file in @($png512, $png64, $ico)) {
    if (Test-Path -LiteralPath $file) { throw "Icon output exists at $file" }
}
[IO.File]::WriteAllBytes($png512, $large)
[IO.File]::WriteAllBytes($png64, ($frames | Where-Object Size -eq 64).Bytes)
$stream = [IO.File]::Open($ico, [IO.FileMode]::CreateNew)
$writer = [IO.BinaryWriter]::new($stream)
try {
    $writer.Write([uint16]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]$frames.Count)
    $offset = 6 + 16 * $frames.Count
    foreach ($frame in $frames) {
        $sizeByte = [byte]($frame.Size % 256)
        $writer.Write($sizeByte)
        $writer.Write($sizeByte)
        $writer.Write([byte]0)
        $writer.Write([byte]0)
        $writer.Write([uint16]1)
        $writer.Write([uint16]32)
        $writer.Write([uint32]$frame.Bytes.Length)
        $writer.Write([uint32]$offset)
        $offset += $frame.Bytes.Length
    }
    foreach ($frame in $frames) { $writer.Write($frame.Bytes) }
} finally {
    $writer.Dispose()
}
Write-Output $ico
