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
  $existing = Get-Command go -ErrorAction SilentlyContinue
  if ($existing) {
    return $existing.Source
  }

  $zipUrl = Resolve-GoArchiveUrl
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

function Ensure-ConductorCli {
  $existing = Resolve-ConductorCommandPath
  if ($existing) {
    return $existing
  }

  $npm = Get-Command npm -ErrorAction SilentlyContinue
  if (-not $npm) {
    Write-Warning "Conductor CLI is not installed and npm is unavailable."
    Write-Warning "Install conductor-oss manually if the bridge daemon cannot locate Conductor."
    return $null
  }

  Write-Host "Installing conductor-oss CLI..."
  New-Item -ItemType Directory -Force -Path $ConductorNpmPrefix | Out-Null
  & $npm.Source install -g --prefix $ConductorNpmPrefix conductor-oss
  if ($LASTEXITCODE -ne 0) {
    throw "npm install -g conductor-oss failed with exit code $LASTEXITCODE"
  }

  return (Resolve-ConductorCommandPath)
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
  & $BridgeBin @args
  if ($LASTEXITCODE -ne 0) {
    throw "Bridge connect failed with exit code $LASTEXITCODE"
  }
}

$goExe = Ensure-Go
Build-Bridge $goExe
Ensure-ConductorCli | Out-Null
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
