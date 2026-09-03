import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'

// Guards the packaging invariants that only show up once a user runs the
// installer — nothing in the app's own code paths can catch a regression here.

const ROOT = path.resolve(__dirname, '..', '..')
const CONFIG_PATH = path.join(ROOT, 'electron-builder.yml')
const CONFIG = readFileSync(CONFIG_PATH, 'utf-8')
const PACKAGE_JSON = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as {
  scripts: Record<string, string>
  devDependencies: Record<string, string>
}

// electron-builder.yml is hand-maintained and flat, so the two lookups below are
// done without pulling in a YAML parser — the repo has no direct one, and adding
// a dependency for a three-assertion test is not worth the lockfile churn.

/** Lines belonging to a top-level `key:` block, up to the next unindented line. */
function block(key: string): string[] {
  const lines = CONFIG.split(/\r?\n/)
  const start = lines.indexOf(`${key}:`)
  if (start === -1) throw new Error(`electron-builder.yml has no top-level "${key}:" block`)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => line.trim() !== '' && !line.startsWith(' '))
  return end === -1 ? rest : rest.slice(0, end)
}

/** Value of a direct `  key: value` child of a top-level block. */
function option(key: string, name: string): string | undefined {
  const line = block(key).find((l) => l.startsWith(`  ${name}:`))
  return line?.slice(line.indexOf(':') + 1).trim()
}

describe('electron-builder.yml', () => {
  it('requests admin for the app executable', () => {
    // ErtCleaner edits HKLM, system directories and other machine-wide state, so the
    // manifest asks for elevation rather than re-launching at runtime.
    expect(option('win', 'requestedExecutionLevel')).toBe('requireAdministrator')
  })

  it('installs per-machine whenever the app manifest requires admin', () => {
    // requestedExecutionLevel is applied to ErtCleaner.exe only; the NSIS installer
    // has a separate execution level derived from nsis.perMachine. If they
    // disagree, the installer runs unelevated and installs an auto-elevating
    // binary into user-writable %LOCALAPPDATA%\Programs — which both breaks the
    // install and is a local privilege-escalation path, since the auto-launch
    // task runs that exe with RunLevel HighestAvailable.
    if (option('win', 'requestedExecutionLevel') === 'requireAdministrator') {
      expect(option('nsis', 'perMachine')).toBe('true')
    }
  })

  it('keeps the one-click installer flow', () => {
    // perMachine + oneClick marks isAdminRightsRequired on NSIS update
    // metadata so an elevated installer stays the only supported install path.
    expect(option('nsis', 'oneClick')).toBe('true')
  })

  it('builds both NSIS and Microsoft Store (AppX) packages', () => {
    const winBlock = block('win').join('\n')
    expect(winBlock).toContain('target: nsis')
    expect(winBlock).toContain('target: appx')
    expect(block('appx').join('\n')).toContain('artifactName: ErtCleaner-Store-${version}.${ext}')
  })

  it('does not let electron-builder publish the GitHub Release', () => {
    // CI sets CI=true, so electron-builder's default publish mode is "always".
    // package.json.repository then makes it try GitHub and fail without GH_TOKEN.
    // The Release workflow uploads the installer with action-gh-release instead.
    for (const script of ['package', 'package:win', 'package:store']) {
      expect(PACKAGE_JSON.scripts[script]).toContain('--publish never')
    }
  })

  it('exposes release-doc validation', () => {
    expect(PACKAGE_JSON.scripts['validate:release-docs']).toBe('node scripts/validate-release-docs.js')
  })

  it('uses the maintained conventional-changelog CLI', () => {
    // conventional-changelog-cli@5 pulled parser 6.4.0 as an optional peer that
    // npm 12 omitted from the lockfile; Node 22's bundled npm 10 then failed `npm ci`.
    expect(PACKAGE_JSON.devDependencies['conventional-changelog-cli']).toBeUndefined()
    expect(PACKAGE_JSON.devDependencies['conventional-changelog']).toBeTruthy()
    expect(PACKAGE_JSON.scripts.changelog).not.toMatch(/(^|\s)-s(\s|$)/)
  })
})

const RELEASE_WORKFLOW = readFileSync(
  path.join(ROOT, '.github', 'workflows', 'release.yml'),
  'utf-8',
)

describe('release workflow', () => {
  it('does not run on the v.0.1.1 extra-dot typo', () => {
    expect(RELEASE_WORKFLOW).toContain("- 'v[0-9]*'")
    expect(RELEASE_WORKFLOW).not.toMatch(/tags:\s*\n\s+-\s+'v\*'/)
  })

  it('rejects tags that are not vMAJOR.MINOR.PATCH', () => {
    expect(RELEASE_WORKFLOW).toContain("^v\\d+\\.\\d+\\.\\d+$")
  })

  it('publishes the installer, Store package, checksum, and SBOM', () => {
    expect(RELEASE_WORKFLOW).toContain('release-assets/ErtCleaner-Setup-*.exe')
    expect(RELEASE_WORKFLOW).toContain('release-assets/ErtCleaner-Setup-*.sha256')
    expect(RELEASE_WORKFLOW).toContain('release-assets/ErtCleaner-Store-*.appx')
    expect(RELEASE_WORKFLOW).toContain('release-assets/ErtCleaner-*.cdx.json')
    expect(RELEASE_WORKFLOW).not.toMatch(/files:\s*\n\s+dist\/ErtCleaner-Setup/)
  })

  it('does not submit artifacts to a signing service', () => {
    expect(RELEASE_WORKFLOW).not.toContain('dist-signed')
    expect(RELEASE_WORKFLOW).not.toContain('environment: release-signing')
    expect(RELEASE_WORKFLOW).not.toContain('verify-signed-release.ps1')
    expect(RELEASE_WORKFLOW).not.toContain('submit-signing-request')
  })
})
