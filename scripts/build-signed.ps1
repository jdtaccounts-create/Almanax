$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$keyPath = $env:ALMANAX_TAURI_SIGNING_KEY
if ([string]::IsNullOrWhiteSpace($keyPath)) {
  $keyPath = Join-Path $HOME '.tauri\updater-keys\almanax.key'
}

if (-not (Test-Path -LiteralPath $keyPath)) {
  throw "Cle de signature Almanax introuvable: $keyPath"
}

$password = $env:ALMANAX_TAURI_SIGNING_KEY_PASSWORD
if ($null -eq $password) {
  $password = $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
}
if ($null -eq $password) {
  $password = ''
}

$previousPath = $env:Path
$configPath = Join-Path ([System.IO.Path]::GetTempPath()) 'almanax-tauri-no-updater-signing.json'

function Sign-Artifact {
  param(
    [Parameter(Mandatory = $true)]
    [string] $FilePath
  )

  $signArgs = @('tauri', 'signer', 'sign', '--private-key-path', $keyPath)
  if ($password.Length -eq 0) {
    $signArgs += '--password='
  } else {
    $signArgs += @('--password', $password)
  }
  $signArgs += $FilePath

  $signatureOutput = (& npx @signArgs) -join "`n"
  if ($LASTEXITCODE -ne 0) {
    throw "Signature impossible: $FilePath"
  }
  if ($signatureOutput -notmatch 'Public signature:\s*(?<signature>[A-Za-z0-9+/=]+)') {
    throw "Signature introuvable dans la sortie Tauri: $FilePath"
  }
  $signature = $Matches.signature
  $signature | Set-Content -NoNewline -LiteralPath "$FilePath.sig"
}

Push-Location $repoRoot
try {
  Set-Content -LiteralPath $configPath -Value '{"bundle":{"createUpdaterArtifacts":false}}'

  $cargoBin = Join-Path $HOME '.cargo\bin'
  if ($env:Path -notlike "*$cargoBin*") {
    $env:Path = "$cargoBin;$env:Path"
  }

  npx tauri build --config $configPath

  $packageJson = Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'package.json') | ConvertFrom-Json
  $version = $packageJson.version
  $bundleDir = Join-Path $repoRoot 'src-tauri\target\release\bundle'
  $setup = Join-Path $bundleDir "nsis\Almanax_${version}_x64-setup.exe"
  $msi = Join-Path $bundleDir "msi\Almanax_${version}_x64_en-US.msi"

  if (-not (Test-Path -LiteralPath $setup)) {
    throw "Setup NSIS introuvable: $setup"
  }
  if (-not (Test-Path -LiteralPath $msi)) {
    throw "MSI introuvable: $msi"
  }

  Sign-Artifact -FilePath $setup
  Sign-Artifact -FilePath $msi

  npm run release:latest
} finally {
  $env:Path = $previousPath
  Remove-Item -LiteralPath $configPath -ErrorAction SilentlyContinue
  Pop-Location
}
