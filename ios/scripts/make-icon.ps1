param(
    [string]$Source = (Join-Path $PSScriptRoot 'appicon-source.png'),
    [int]$Inset = 36
)

Add-Type -AssemblyName System.Drawing

# Build the iOS AppIcon (1024x1024, RGB without alpha) from the design artwork.
# Artwork: scripts/appicon-source.png (the icon image supplied for 0.1.2)

$size = 1024
$output = Join-Path $PSScriptRoot '..\ZhuijuAI\Assets.xcassets\AppIcon.appiconset\AppIcon-1024.png'

if (-not (Test-Path -LiteralPath $Source)) {
    throw "Artwork not found: $Source"
}

$art = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $Source).Path)
try {
    $bitmap = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

    # Trim the artwork's outer white frame so iOS rounded corners have no white bleed.
    $border = [Math]::Min($Inset, [Math]::Min($art.Width, $art.Height) / 4)
    $srcRect = New-Object System.Drawing.Rectangle(
        [int]$border,
        [int]$border,
        [int]($art.Width - 2 * $border),
        [int]($art.Height - 2 * $border)
    )
    $dstRect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
    $graphics.DrawImage($art, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)

    $directory = Split-Path -Parent $output
    if (-not (Test-Path -LiteralPath $directory)) {
        New-Item -ItemType Directory -Path $directory | Out-Null
    }
    $bitmap.Save($output, [System.Drawing.Imaging.ImageFormat]::Png)

    $graphics.Dispose()
    $bitmap.Dispose()
} finally {
    $art.Dispose()
}

Write-Output "icon: $output"
