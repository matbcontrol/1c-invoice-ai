# Прогон автотестов разбора документов поставщиков на копии демобазы УНФ.
# Поднимает мок Claude API (tools/claude-mock.js), восстанавливает базу из эталона до и после прогона,
# после тестов проверяет пакетный запуск по папке, как его вызовет планировщик Windows.
# Пример: tools\test.ps1 -Base C:\1C\UNF_demo -Reference C:\1C\UNF_ref\1Cv8.1CD -Build
param(
    [string]$Base = $env:UNF_BASE,
    [string]$Reference = $env:UNF_REFERENCE,
    [switch]$Build, [int]$TimeoutMin = 20, [int]$Port = 8472,
    [string]$User = "Администратор",
    [string]$Platform = "C:\Program Files (x86)\1cv8t\8.5.1.1150\bin\1cv8t.exe"
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot
$mock = "http://127.0.0.1:$Port"
$busy = Get-CimInstance Win32_Process -Filter "Name like '1cv8%'" | Where-Object { $_.CommandLine -like "*$Base*" }
if ($busy) { "Закройте 1С на базе $Base`: учебная версия пускает одно подключение"; exit 1 }
if ($Build) {
    & "$PSScriptRoot\build_epf.ps1" -Src "$root\src\РазборДокументовПоставщиков.xml" -Out "$root\build\РазборДокументовПоставщиков.epf" -Base $Base -User $User -Platform $Platform
    & "$PSScriptRoot\build_epf.ps1" -Src "$root\tests\src\ТестыРазбораДокументов.xml" -Out "$root\tests\build\ТестыРазбораДокументов.epf" -Base $Base -User $User -Platform $Platform
}
foreach ($epf in "$root\build\РазборДокументовПоставщиков.epf", "$root\tests\build\ТестыРазбораДокументов.epf") {
    if (-not (Test-Path $epf)) { "Нет $epf, соберите с ключом -Build"; exit 1 }
}

function Run-1C([string]$Epf, [string]$Param, [int]$Minutes) {
    $argLine = "ENTERPRISE /F `"$Base`" /N `"$User`" /DisableStartupDialogs /DisableStartupMessages /Execute `"$Epf`" /C `"$Param`""
    $p = Start-Process $Platform -ArgumentList $argLine -PassThru
    if (-not $p.WaitForExit($Minutes * 60000)) { Stop-Process -Id $p.Id -Force; Start-Sleep 2; "TIMEOUT $Epf" }
}

$node = Start-Process node -ArgumentList "`"$root\tools\claude-mock.js`" --port $Port" -PassThru -WindowStyle Hidden
$ready = $false
for ($i = 0; $i -lt 50 -and -not $ready; $i++) {
    try { Invoke-RestMethod "$mock/__mock/log" | Out-Null; $ready = $true } catch { Start-Sleep -Milliseconds 200 }
}
if (-not $ready) {
    "Мок Claude API не запустился"
    if (-not $node.HasExited) { Stop-Process -Id $node.Id -Force }
    exit 1
}

$report = "$root\tests\last_run.txt"
$batch = "$root\tests\batch_run.txt"
$inbox = Join-Path $env:TEMP "invoice-ai-inbox"
Remove-Item $report, $batch -ErrorAction SilentlyContinue
try {
    Copy-Item $Reference "$Base\1Cv8.1CD" -Force
    Run-1C "$root\tests\build\ТестыРазбораДокументов.epf" "Тесты;$root\build\РазборДокументовПоставщиков.epf;$root;$report;$mock" $TimeoutMin

    # Пакетный запуск на той же базе: тесты сохранили настройки. В папке новый УПД и скан с неверным ИНН.
    Remove-Item $inbox -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory $inbox | Out-Null
    Copy-Item "$root\samples\pdf\УПД АЛЬФАМАРТ 1310 от 21.11.2026.pdf", "$root\samples\pdf\Скан УПД Русский дом РД-0461.pdf" $inbox
    Invoke-RestMethod -Method Post "$mock/__mock/reset" | Out-Null
    Run-1C "$root\build\РазборДокументовПоставщиков.epf" "РазобратьПапку;$inbox;$batch" 5
}
finally {
    try { Invoke-RestMethod -Method Post "$mock/__mock/shutdown" | Out-Null } catch { }
    Remove-Item $inbox -Recurse -Force -ErrorAction SilentlyContinue
    Copy-Item $Reference "$Base\1Cv8.1CD" -Force
    "база восстановлена из эталона"
}

if (-not (Test-Path $report)) { "НЕТ ОТЧЁТА ТЕСТОВ"; exit 1 }
$lines = @(Get-Content $report -Encoding UTF8)
$batchText = if (Test-Path $batch) { @(Get-Content $batch -Encoding UTF8) } else { @("нет отчёта пакетного запуска") }
$batchOk = ($batchText -join "`n") -match "Создано документов: 1, пропущено: 0, ошибок: 0" -and ($batchText -join "`n") -match "Проверить ИНН"
$lines += ""
$lines += "Пакетный запуск: обработка с параметром РазобратьПапку, как из планировщика"
$lines += $(if ($batchOk) { "  ok    новый УПД создан, скан с неверным ИНН остался в отчёте" } else { "  FAIL  пакетный запуск" })
$lines += $batchText | ForEach-Object { "        " + $_ }
$m = [regex]::Match($lines[0], "Проверок: (\d+), пройдено: (\d+), не пройдено: (\d+)")
if ($m.Success) {
    $total = [int]$m.Groups[1].Value + 1
    $passed = [int]$m.Groups[2].Value + [int]$batchOk
    $failed = [int]$m.Groups[3].Value + [int](-not $batchOk)
    $lines[0] = $lines[0] -replace "Проверок: \d+, пройдено: \d+, не пройдено: \d+", "Проверок: $total, пройдено: $passed, не пройдено: $failed"
}
$lines | Set-Content $report -Encoding UTF8
$lines
