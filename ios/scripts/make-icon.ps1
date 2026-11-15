Add-Type -AssemblyName System.Drawing

$size = 1024
$output = Join-Path $PSScriptRoot '..\ZhuijuAI\Assets.xcassets\AppIcon.appiconset\AppIcon-1024.png'
$bitmap = New-Object System.Drawing.Bitmap($size, $size)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

$background = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
$backBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $background,
    [System.Drawing.ColorTranslator]::FromHtml('#122033'),
    [System.Drawing.ColorTranslator]::FromHtml('#060A12'),
    90
)
$graphics.FillRectangle($backBrush, $background)

$circle = New-Object System.Drawing.Rectangle(212, 176, 600, 600)
$circleBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $circle,
    [System.Drawing.ColorTranslator]::FromHtml('#22D3EE'),
    [System.Drawing.ColorTranslator]::FromHtml('#2563EB'),
    45
)
$graphics.FillEllipse($circleBrush, $circle)

$play = New-Object System.Drawing.Drawing2D.GraphicsPath
$playPoints = [System.Drawing.Point[]]@(
    [System.Drawing.Point]::new(452, 350),
    [System.Drawing.Point]::new(452, 602),
    [System.Drawing.Point]::new(652, 476)
)
$play.AddPolygon($playPoints)
$graphics.FillPath([System.Drawing.Brushes]::White, $play)

$font = New-Object System.Drawing.Font('Microsoft YaHei', 96, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$format = New-Object System.Drawing.StringFormat
$format.Alignment = [System.Drawing.StringAlignment]::Center
$format.LineAlignment = [System.Drawing.StringAlignment]::Center
$textBrush = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#F8FAFC'))
$graphics.DrawString('追剧AI', $font, $textBrush, (New-Object System.Drawing.RectangleF(0, 790, 1024, 160)), $format)

$directory = Split-Path -Parent $output
if (-not (Test-Path -LiteralPath $directory)) {
    New-Item -ItemType Directory -Path $directory | Out-Null
}
$bitmap.Save($output, [System.Drawing.Imaging.ImageFormat]::Png)

$textBrush.Dispose()
$font.Dispose()
$play.Dispose()
$circleBrush.Dispose()
$backBrush.Dispose()
$graphics.Dispose()
$bitmap.Dispose()

Write-Output "icon: $output"
