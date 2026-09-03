<p align="center">
  <img src="logo.png" alt="ErtCleaner" width="128" height="128">
</p>

[Türkçe](README.md) | **English**

# ErtCleaner

A modern, open-source system cleaner for Windows.

[![CI](https://github.com/ErtugrulKra/ErtCleaner/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/ErtugrulKra/ErtCleaner/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/ErtugrulKra/ErtCleaner)](https://github.com/ErtugrulKra/ErtCleaner/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Windows x64** only. The UI is **Turkish**. Scans, cleaning history, and settings stay **on this computer**; there is no cloud backend for core processing. Setup requests elevation and installs under Program Files.

Download **only from official [GitHub Releases](https://github.com/ErtugrulKra/ErtCleaner/releases)**. ErtCleaner runs elevated. Vulnerability reports: [SECURITY.md](SECURITY.md). Third-party components: [docs/third-party-components.md](docs/third-party-components.md).

## Download and install

1. Open the [latest release](https://github.com/ErtugrulKra/ErtCleaner/releases/latest).
2. Download `ErtCleaner-Setup-{version}.exe`. Optionally verify it with the adjacent `.sha256` file.
3. Run setup. UAC elevation is required; the install is **per-machine** (Program Files).

GitHub Release installers are **unsigned**. Windows SmartScreen may show an unknown-publisher warning. The source is public; use the checksum to confirm the file matches the Release asset.

In-app automatic updates for ErtCleaner itself are **off**. Install a newer version from GitHub Releases.

## Uninstall

- **Windows Settings:** Settings → Apps → Installed apps → ErtCleaner → Uninstall.
- **NSIS uninstaller:** `C:\Program Files\ErtCleaner\Uninstall ErtCleaner.exe` (`productName: ErtCleaner`, `perMachine: true` in electron-builder).

Setup sets `deleteAppDataOnUninstall: false`, so local app data is kept. Packaged `userData` is `%APPDATA%\ErtCleaner`. Development sessions may use `%APPDATA%\ErtCleaner\ErtCleaner-Dev`. `--ertcleaner-data-dir=` overrides the directory when supplied.

## What it does and does not do

ErtCleaner works on disk, the registry, services, and Windows settings. Most operations can be protected with reversible backups, a system restore point, quarantine, or a snapshot. It still runs as administrator, so choose items from scan results.

It does **not**:

- Call Windows Defender as a scan engine. Malware scanning is local heuristic analysis and persistence checks.
- Scan remote hosts, open ports, or passwords; it is not an exploit scanner or remote-admin agent.
- Update itself.
- Send telemetry or upload scan/cleaning results to a remote server.

## Features

Each tool scans or lists first; deletion and system changes require your confirmation.

### Cleaning

**Home.** Disk use, a light CPU/RAM summary, and a health score. One-click clean runs the cleaner categories, registry repair, malware scan, and privacy scan you selected. First launch shows a short setup wizard.

**System cleaner.** JSON rules (`rules/win32/`) for system, browser, app, game, GPU cache, Recycle Bin, broken shortcuts, environment variables, and SQLite database candidates. Optional restore point, secure delete, and exclusions.

**Registry.** Orphaned and invalid keys plus local hardening findings (UAC off, Defender off, firewall off, AutoRun). Fixes apply only to selected keys; optional `.reg` backup.

**Startup.** Run keys, startup folders, and scheduled tasks. Enable, disable, delete. Optional Event Log boot trace.

**Network.** DNS cache, Wi-Fi profiles, ARP cache, and saved network profiles.

**Scheduled maintenance.** Up to 10 jobs (daily / weekly / monthly).

### Protection

**Malware.** Local multi-stage scan: PE and script heuristics, hosts-file tampering, Run keys, and scheduled-task persistence. Quarantine, delete, or allowlist. No signature cloud and no Windows Defender integration.

**Privacy shield.** Scores telemetry, ads, search, sync, and Windows AI-related registry/task settings and applies the ones you select on this machine.

**Firewall audit.** Inspects **local** Windows Firewall rules (stale, unsigned, or overly broad). Bulk disable/delete is available. It does not scan remote ports.

### Performance, software, storage, game mode

Live performance graphs, service manager, winget (plus Chocolatey/Scoop/npm) software updates, driver cleanup via `pnputil` / Windows Update, program uninstall and leftover cleanup, bloatware removal, Explorer context-menu cleanup, disk maps, duplicates, large files, empty folders, a 2-pass file shredder with protected roots, SFC/DISM/CHKDSK, TRIM, and a reversible game-mode snapshot.

## Command line

```text
ErtCleaner.exe --cli <command> [subcommand] [options]
```

Useful flags: `--json`, `--verbose`, `-q` / `--quiet`, `--all`, `-h`, `-v`. Optional `metrics-server` binds `0.0.0.0` only when you start it.

See [README.md](README.md) for the full Turkish command table.

## License

MIT. See [LICENSE](LICENSE).
