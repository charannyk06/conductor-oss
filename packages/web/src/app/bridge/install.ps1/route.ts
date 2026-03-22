import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const GO_VERSION = "1.26.1";

function resolveSourceArchiveUrl(): string {
  const commitSha = process.env.VERCEL_GIT_COMMIT_SHA?.trim();
  if (commitSha) {
    return `https://github.com/charannyk06/conductor-oss/archive/${commitSha}.zip`;
  }

  return "https://github.com/charannyk06/conductor-oss/archive/refs/heads/main.zip";
}

function buildInstallScript(sourceArchiveUrl: string): string {
  return `param(
  [switch]$Connect,
  [string]$DashboardUrl = "",
  [string]$RelayUrl = "",
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$GoVersion = "${GO_VERSION}"
$SourceArchiveUrl = "${sourceArchiveUrl}"
$ConductorHome = Join-Path $HOME ".conductor"
$InstallBinDir = Join-Path $ConductorHome "bin"
$ConductorNpmPrefix = Join-Path $ConductorHome "npm"
$BridgeBin = Join-Path $InstallBinDir "conductor-bridge.exe"
$LocalGoRoot = Join-Path $ConductorHome "go"

function Resolve-GoArchiveUrl {
  $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
  switch ($arch) {
    "X64" { return "https://go.dev/dl/go$GoVersion.windows-amd64.zip" }
    "Arm64" { return "https://go.dev/dl/go$GoVersion.windows-arm64.zip" }
    default { throw "Unsupported Windows architecture: $arch" }
  }
}

function Ensure-Go {
  Write-Host "Checking for Go toolchain..."
  $existing = Get-Command go -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Host "Using existing Go at $($existing.Source)"
    return $existing.Source
  }

  $zipUrl = Resolve-GoArchiveUrl
  Write-Host "Downloading Go $GoVersion for Windows..."
  $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
  try {
    $zipPath = Join-Path $tempRoot "go.zip"
    Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath
    $localGoParent = Split-Path $LocalGoRoot -Parent
    New-Item -ItemType Directory -Force -Path $localGoParent | Out-Null
    if (Test-Path $LocalGoRoot) {
      Remove-Item -Recurse -Force $LocalGoRoot
    }
    Expand-Archive -Path $zipPath -DestinationPath $localGoParent -Force
    return (Join-Path $LocalGoRoot "bin\\go.exe")
  } finally {
    if (Test-Path $tempRoot) {
      Remove-Item -Recurse -Force $tempRoot
    }
  }
}

function Build-Bridge($goExe) {
  Write-Host "Downloading Conductor Bridge source..."
  $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
  try {
    $zipPath = Join-Path $tempRoot "source.zip"
    Invoke-WebRequest -Uri $SourceArchiveUrl -OutFile $zipPath
    Expand-Archive -Path $zipPath -DestinationPath $tempRoot -Force
    $sourceDir = Get-ChildItem -Path $tempRoot -Directory | Select-Object -First 1
    if (-not $sourceDir) {
      throw "Failed to locate bridge source in downloaded archive."
    }
    $bridgeSourceDir = Join-Path $sourceDir.FullName "bridge-cmd"
    if (-not (Test-Path $bridgeSourceDir)) {
      throw "Failed to locate bridge source in downloaded archive."
    }

    New-Item -ItemType Directory -Force -Path $InstallBinDir | Out-Null
    Write-Host "Building conductor-bridge.exe..."
    $previousPath = $env:PATH
    try {
      $env:PATH = (Split-Path $goExe -Parent) + ";" + $previousPath
      Push-Location $bridgeSourceDir
      & $goExe build -o $BridgeBin .
      if ($LASTEXITCODE -ne 0) {
        throw "go build failed with exit code $LASTEXITCODE"
      }
    } finally {
      Pop-Location
      $env:PATH = $previousPath
    }
  } finally {
    if (Test-Path $tempRoot) {
      Remove-Item -Recurse -Force $tempRoot
    }
  }
}

function Resolve-ConductorCommandPath {
  $candidates = @(
    (Join-Path $ConductorNpmPrefix "bin\\conductor.cmd"),
    (Join-Path $ConductorNpmPrefix "bin\\conductor"),
    (Join-Path $HOME ".local\\bin\\conductor.cmd"),
    (Join-Path $HOME ".local\\bin\\conductor"),
    (Join-Path $env:APPDATA "npm\\conductor.cmd")
  )

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) {
      return $candidate
    }
  }

  $command = Get-Command conductor -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  return $null
}

function Run-Connect {
  if (-not $Connect) {
    return
  }
  if (-not $DashboardUrl) {
    throw "-DashboardUrl is required when using -Connect"
  }

  $args = @("connect", "--dashboard-url", $DashboardUrl)
  if ($RelayUrl) {
    $args += @("--relay-url", $RelayUrl)
  }
  if ($NoBrowser) {
    $args += "--no-browser"
  }

  Write-Host "Starting Conductor Bridge pairing for dashboard: $DashboardUrl"
  Write-Host "If this machine is already paired, the relay will rotate the previous refresh token for this device."
  & $BridgeBin @args
  if ($LASTEXITCODE -ne 0) {
    throw "Bridge connect failed with exit code $LASTEXITCODE"
  }
}

$goExe = Ensure-Go
Build-Bridge $goExe
Write-Host "Installing bridge background service..."
& $BridgeBin install
if ($LASTEXITCODE -ne 0) {
  throw "Bridge install failed with exit code $LASTEXITCODE"
}

Write-Host "Installed conductor-bridge to $BridgeBin"
if ($DashboardUrl) {
  Write-Host "Bridge service installed. Future reconnects can use: conductor-bridge connect --dashboard-url $DashboardUrl"
} else {
  Write-Host "Bridge service installed. Future reconnects can use: conductor-bridge connect --dashboard-url <your dashboard URL>"
}
Write-Host "Bridge setup does not need the full Conductor CLI first. You can install conductor-oss later if needed."
Run-Connect
`;
}

export async function GET(): Promise<Response> {
  return new NextResponse(buildInstallScript(resolveSourceArchiveUrl()), {
    headers: {
      "content-type": "text/x-powershell; charset=utf-8",
      "cache-control": "public, max-age=60, s-maxage=60",
    },
  });
}
