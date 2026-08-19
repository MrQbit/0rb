# orb2 — Windows installer (PowerShell). Requires Docker Desktop (WSL2).
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1
# Runs the cloud-brain flow through WSL bash (the stack is Linux containers);
# a local NVIDIA brain on Windows is not supported — use WSL2 + the Linux
# install inside your distro if you have a large NVIDIA GPU.
$ErrorActionPreference = "Stop"
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Host "Docker Desktop is required: https://docs.docker.com/desktop/setup/install/windows-install/" -ForegroundColor Yellow
  exit 1
}
if (-not (Get-Command wsl -ErrorAction SilentlyContinue)) {
  Write-Host "WSL2 is required (wsl --install), then re-run." -ForegroundColor Yellow
  exit 1
}
Write-Host "Launching the orb2 installer inside WSL..." -ForegroundColor Green
wsl bash -lc "cd $(($PWD.Path -replace '\\','/' -replace '^([A-Za-z]):','/mnt/$1'.ToLower())); bash scripts/install-cloudbrain.sh"
