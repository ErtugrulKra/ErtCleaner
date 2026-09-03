# Third-party components

ErtCleaner is MIT-licensed and does not ship proprietary code owned by the maintainer or an affiliated entity. This file lists the native and packaged components shipped with or used to build ErtCleaner. A machine-readable CycloneDX SBOM (`ErtCleaner-<version>.cdx.json`) is published with each GitHub Release.

## Project license

- License: [MIT](../LICENSE)
- Dual licensing: none
- Maintainer-owned closed-source components: none

## Runtime and native modules (shipped)

| Component | Role | License | Provenance |
| --- | --- | --- | --- |
| `electron` | Desktop shell (Chromium + Node) | [Electron license](https://github.com/electron/electron/blob/main/LICENSE) | npm `electron`, rebuilt into the NSIS installer by electron-builder |
| `better-sqlite3` | Local SQLite for cleaner/history data | MIT | npm `better-sqlite3`; native addon rebuilt on install via `electron-rebuild -w better-sqlite3` |
| `@litko/yara-x` | Optional local YARA-X scanner | MIT | npm `@litko/yara-x` ([cawalch/node-yara-x](https://github.com/cawalch/node-yara-x)); Windows x64 native binary from that package |
| `systeminformation` | Local CPU/RAM/disk metrics | MIT | npm `systeminformation` |

Remote YARA rule download and signature clouds are disabled. The malware scanner uses local heuristics and, when present, locally bundled YARA rules.

## Packaged extra resources

[electron-builder.yml](../electron-builder.yml) `extraResources` copies only application icons from `resources/` (`icon.ico`, `icon.png`, `resources/icons`). No third-party executables are bundled there.

## System libraries

The installed application may load Windows system libraries (for example `advapi32`, PowerShell, `pnputil`, Windows Installer). Those are not redistributed by this project.

## Build tooling (not shipped in the installer)

Dev-only tools such as `electron-builder`, `electron-vite`, TypeScript, Vitest, and `@cyclonedx/cyclonedx-npm` appear in the SBOM as development dependencies. They are not part of `ErtCleaner.exe`.
