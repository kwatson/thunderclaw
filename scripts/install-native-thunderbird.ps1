param(
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$Sha512
)

$ErrorActionPreference = "Stop"
if (!(Test-Path Env:RUNNER_TEMP) -or !(Test-Path Env:GITHUB_OUTPUT)) {
  throw "RUNNER_TEMP and GITHUB_OUTPUT are required"
}
if ($Version -notmatch '^\d+\.\d+(?:\.\d+)?(?:esr)?$') {
  throw "Invalid Thunderbird version: $Version"
}
if ($Sha512 -notmatch '^[0-9a-fA-F]{128}$') {
  throw "Thunderbird SHA-512 must contain exactly 128 hexadecimal characters"
}

$installer = Join-Path $env:RUNNER_TEMP "thunderbird-$Version.exe"
$url = "https://archive.mozilla.org/pub/thunderbird/releases/$Version/win64/en-US/Thunderbird%20Setup%20$Version.exe"

Invoke-WebRequest -Uri $url -OutFile $installer -MaximumRetryCount 3 -RetryIntervalSec 2
$actual = (Get-FileHash -Algorithm SHA512 -LiteralPath $installer).Hash.ToLowerInvariant()
if ($actual -ne $Sha512.ToLowerInvariant()) {
  throw "Thunderbird $Version SHA-512 mismatch"
}

$installRoot = Join-Path $env:RUNNER_TEMP "thunderbird-$Version"
if (Test-Path -LiteralPath $installRoot) {
  throw "Refusing to reuse Thunderbird install directory: $installRoot"
}

$sevenZip = Get-Command 7z.exe -ErrorAction SilentlyContinue
if ($null -eq $sevenZip) {
  $bundledSevenZip = Join-Path $env:ProgramFiles "7-Zip\7z.exe"
  if (!(Test-Path -LiteralPath $bundledSevenZip -PathType Leaf)) {
    throw "7-Zip is required to extract the Thunderbird package"
  }
  $sevenZipPath = $bundledSevenZip
} else {
  $sevenZipPath = $sevenZip.Source
}

& $sevenZipPath x -y "-o$installRoot" $installer
$extractExitCode = $LASTEXITCODE
# Signed Mozilla self-extracting archives can produce 7-Zip warning code 1
# because signature data follows the embedded archive. Codes above 1 are fatal.
if ($extractExitCode -gt 1) {
  throw "7-Zip extraction exited $extractExitCode"
}

$applicationRoot = Join-Path $installRoot "core"
$executable = Join-Path $applicationRoot "thunderbird.exe"
$applicationIni = Join-Path $applicationRoot "application.ini"
if (!(Test-Path -LiteralPath $executable -PathType Leaf) -or !(Test-Path -LiteralPath $applicationIni -PathType Leaf)) {
  throw "Thunderbird installer did not contain the expected core application layout"
}

"thunderbird=$executable" | Out-File -FilePath $env:GITHUB_OUTPUT -Encoding utf8 -Append
"application_ini=$applicationIni" | Out-File -FilePath $env:GITHUB_OUTPUT -Encoding utf8 -Append
