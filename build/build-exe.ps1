# ============================================================================
# build-exe.ps1 — пересборка dist\AgroGardSklad.exe из исходников приложения.
#
# Требования:
#   - Windows 10/11, .NET Framework 4.x (csc.exe входит в состав ОС);
#   - интернет при ПЕРВОМ запуске (скачивается WebView2 SDK с nuget.org;
#     дальше используется кэш в build\.cache);
#   - WebView2 Runtime на машине пользователя (предустановлен в Windows 11
#     и в Windows 10 с актуальным Microsoft Edge).
#
# Запуск:  powershell -ExecutionPolicy Bypass -File build\build-exe.ps1
# ============================================================================
$ErrorActionPreference = 'Stop'

$build  = $PSScriptRoot                                  # папка build\
$proj   = Split-Path $build -Parent                      # корень проекта
$cache  = Join-Path $build '.cache'
$wv2dir = Join-Path $cache 'wv2'
$csc    = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'

# --- 1. WebView2 SDK (нужен только для компиляции) ---------------------------
if (-not (Test-Path "$wv2dir\lib\net462\Microsoft.Web.WebView2.WinForms.dll")) {
    Write-Host 'Скачивание WebView2 SDK с nuget.org...'
    New-Item -ItemType Directory -Force -Path $cache | Out-Null
    $pkg = Join-Path $cache 'wv2.zip'
    Invoke-WebRequest -Uri 'https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/1.0.2903.40' `
        -OutFile $pkg -UseBasicParsing -TimeoutSec 120
    Expand-Archive -LiteralPath $pkg -DestinationPath $wv2dir -Force
}

# --- 2. Упаковка файлов приложения -------------------------------------------
$zip = Join-Path $cache 'app.zip'
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path "$proj\index.html", "$proj\css", "$proj\js", "$proj\assets", "$proj\templates", "$proj\README.md" `
    -DestinationPath $zip -CompressionLevel Optimal

# --- 3. Компиляция однофайлового exe ------------------------------------------
New-Item -ItemType Directory -Force -Path "$proj\dist" | Out-Null
$lib = "$wv2dir\lib\net462"
& $csc /nologo /target:winexe /platform:x64 /optimize+ `
    /out:"$proj\dist\AgroGardSklad.exe" `
    /win32icon:"$build\app.ico" `
    "$build\Launcher.cs" `
    /r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Core.dll `
    /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll `
    /r:"$lib\Microsoft.Web.WebView2.Core.dll" /r:"$lib\Microsoft.Web.WebView2.WinForms.dll" `
    /resource:"$zip",AgroGardSklad.app.zip `
    /resource:"$wv2dir\runtimes\win-x64\native\WebView2Loader.dll",AgroGardSklad.WebView2Loader.dll `
    /resource:"$build\app.ico",AgroGardSklad.app.ico `
    /resource:"$lib\Microsoft.Web.WebView2.Core.dll",AgroGardSklad.Microsoft.Web.WebView2.Core.dll `
    /resource:"$lib\Microsoft.Web.WebView2.WinForms.dll",AgroGardSklad.Microsoft.Web.WebView2.WinForms.dll

if ($LASTEXITCODE -eq 0) {
    Write-Host "Готово: $proj\dist\AgroGardSklad.exe" -ForegroundColor Green
} else {
    Write-Host 'Ошибка компиляции' -ForegroundColor Red
    exit 1
}

# ВАЖНО: при изменении файлов приложения поднимите AppVersion в Launcher.cs,
# чтобы exe переизвлёк обновлённые файлы у пользователей.
