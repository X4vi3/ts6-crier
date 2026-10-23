# ts6-crier installer for Windows. In PowerShell:
#
#   irm https://raw.githubusercontent.com/X4vi3/ts6-crier/main/install.ps1 | iex
#
# Installs to %LOCALAPPDATA%\ts6-crier, puts a shortcut on the desktop and
# starts the bot; the first start asks for the server address. Run it again to
# update - config, identity, custom sounds and state are kept.
#
# Environment: CRIER_VERSION (a release tag, default latest), CRIER_DIR,
# CRIER_ARCHIVE (install from a downloaded zip), CRIER_NO_SHORTCUT, CRIER_NO_START.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # the progress bar makes downloads crawl in 5.1

$Repo = if ($env:CRIER_REPO) { $env:CRIER_REPO } else { 'X4vi3/ts6-crier' }
$Dir = if ($env:CRIER_DIR) { $env:CRIER_DIR } else { Join-Path $env:LOCALAPPDATA 'ts6-crier' }
$Asset = 'ts6-crier-windows-x64.zip'
$Url = if ($env:CRIER_VERSION) {
  "https://github.com/$Repo/releases/download/$($env:CRIER_VERSION)/$Asset"
} else {
  "https://github.com/$Repo/releases/latest/download/$Asset"
}

$Tmp = Join-Path ([IO.Path]::GetTempPath()) ("ts6-crier-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force $Tmp | Out-Null
try {
  if ($env:CRIER_ARCHIVE) {
    Copy-Item $env:CRIER_ARCHIVE (Join-Path $Tmp $Asset)
  } else {
    Write-Host "==> downloading $Asset" -ForegroundColor Cyan
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile (Join-Path $Tmp $Asset)
  }
  Expand-Archive -Path (Join-Path $Tmp $Asset) -DestinationPath $Tmp -Force
  $New = Join-Path $Tmp 'ts6-crier'

  # A running copy holds its .exe open; it has to stop before it can be replaced.
  $exe = Join-Path $Dir 'ts6-crier.exe'
  Get-Process ts6-crier -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $exe } |
    ForEach-Object { Write-Host "==> stopping the running bot" -ForegroundColor Cyan; $_ | Stop-Process -Force; Start-Sleep 1 }

  $updating = Test-Path $exe
  New-Item -ItemType Directory -Force (Join-Path $Dir 'sounds') | Out-Null

  # The program is always replaced; sounds and the avatar only when missing,
  # so a replaced gong.mp3 survives the update.
  foreach ($f in 'ts6-crier.exe', 'ffmpeg.exe', 'opusscript_native_wasm.wasm', 'config.example.yml',
                 'README.md', 'README.ru.md', 'LICENSE', 'THIRD-PARTY-NOTICES.txt') {
    $src = Join-Path $New $f
    if (Test-Path $src) { Copy-Item $src (Join-Path $Dir $f) -Force }
  }
  Get-ChildItem (Join-Path $New 'sounds') -File | ForEach-Object {
    $dst = Join-Path (Join-Path $Dir 'sounds') $_.Name
    if (-not (Test-Path $dst)) { Copy-Item $_.FullName $dst }
  }
  $avatar = Join-Path $Dir 'avatar.png'
  if (-not (Test-Path $avatar) -and (Test-Path (Join-Path $New 'avatar.png'))) { Copy-Item (Join-Path $New 'avatar.png') $avatar }

  $shell = New-Object -ComObject WScript.Shell
  if (-not $env:CRIER_NO_SHORTCUT) { foreach ($where in [Environment]::GetFolderPath('Desktop'), (Join-Path ([Environment]::GetFolderPath('Programs')) '')) {
    $lnk = $shell.CreateShortcut((Join-Path $where 'TS6 Crier.lnk'))
    $lnk.TargetPath = $exe
    $lnk.WorkingDirectory = $Dir
    $lnk.Description = 'Voice announcer bot for TeamSpeak'
    $lnk.Save()
  } }

  if ($updating) { $verb = 'updated' } else { $verb = 'installed' }
  Write-Host "==> $verb in $Dir" -ForegroundColor Cyan
  Write-Host ""
  Write-Host "  Start:     'TS6 Crier' shortcut on the desktop (close the window to stop)"
  Write-Host "  Settings:  $Dir\config.yml"
  Write-Host "  Update:    run this command again"
  Write-Host ""
  if (-not $env:CRIER_NO_START) { Start-Process -FilePath $exe -WorkingDirectory $Dir }
} finally {
  Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}
