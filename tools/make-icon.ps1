<#
    Genere src/Organizator/app.ico : disque terracotta #c67139 sur fond creme
    #f5ead8, avec un « O » blanc en serif gras. Les images sont stockees au
    format PNG dans le conteneur ICO (format Vista, accepte par Windows et par
    le compilateur de ressources Win32).

    Usage : powershell -ExecutionPolicy Bypass -File tools\make-icon.ps1
#>
[CmdletBinding()]
param(
    [string] $OutputPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $root = Split-Path -Parent $MyInvocation.MyCommand.Path
    $OutputPath = Join-Path $root '..\src\Organizator\app.ico'
}

Add-Type -AssemblyName System.Drawing

$sizes = @(16, 32, 48, 64, 128, 256)
$cream = [System.Drawing.ColorTranslator]::FromHtml('#f5ead8')
$terra = [System.Drawing.ColorTranslator]::FromHtml('#c67139')

function New-IconPng([int] $size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

        # Fond creme, coins arrondis pour les grandes tailles.
        $bg = New-Object System.Drawing.SolidBrush($cream)
        $g.FillRectangle($bg, 0, 0, $size, $size)
        $bg.Dispose()

        # Disque terracotta.
        $inset = [Math]::Max(1, [int][Math]::Round($size * 0.06))
        $d = $size - (2 * $inset)
        $disc = New-Object System.Drawing.SolidBrush($terra)
        $g.FillEllipse($disc, $inset, $inset, $d, $d)
        $disc.Dispose()

        # Le « O » blanc.
        $familyName = @('Georgia', 'Cambria', 'Times New Roman') |
            Where-Object { $null -ne ([System.Drawing.FontFamily]::Families | Where-Object Name -eq $_) } |
            Select-Object -First 1
        if (-not $familyName) { $familyName = 'Times New Roman' }

        $emSize = $size * 0.62
        $font = New-Object System.Drawing.Font($familyName, $emSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
        $fmt = New-Object System.Drawing.StringFormat
        $fmt.Alignment = [System.Drawing.StringAlignment]::Center
        $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
        $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
        $rect = New-Object System.Drawing.RectangleF(0, [single]($size * 0.02), [single]$size, [single]$size)
        $g.DrawString('O', $font, $white, $rect, $fmt)
        $white.Dispose(); $fmt.Dispose(); $font.Dispose()
    } finally {
        $g.Dispose()
    }

    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    return ,$ms.ToArray()
}

$images = @{}
foreach ($s in $sizes) { $images[$s] = New-IconPng $s }

$out = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter($out)
try {
    $w.Write([uint16]0)              # reserve
    $w.Write([uint16]1)              # type = icone
    $w.Write([uint16]$sizes.Count)

    $offset = 6 + (16 * $sizes.Count)
    foreach ($s in $sizes) {
        $bytes = $images[$s]
        $dim = if ($s -ge 256) { 0 } else { $s }
        $w.Write([byte]$dim)         # largeur
        $w.Write([byte]$dim)         # hauteur
        $w.Write([byte]0)            # palette
        $w.Write([byte]0)            # reserve
        $w.Write([uint16]1)          # plans
        $w.Write([uint16]32)         # bits par pixel
        $w.Write([uint32]$bytes.Length)
        $w.Write([uint32]$offset)
        $offset += $bytes.Length
    }
    foreach ($s in $sizes) { $w.Write($images[$s]) }
    $w.Flush()

    $full = [System.IO.Path]::GetFullPath($OutputPath)
    $dir = [System.IO.Path]::GetDirectoryName($full)
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [System.IO.File]::WriteAllBytes($full, $out.ToArray())
    Write-Host "Icone ecrite : $full ($($out.Length) octets, tailles $($sizes -join '/'))"
} finally {
    $w.Dispose(); $out.Dispose()
}
