import { describe, it, expect } from 'vitest'
import { resolvePath, buildCleanerPaths } from './loader'
import type { RulesJsonSet } from './loader'

describe('resolvePath', () => {
  const vars = { HOME: 'C:\\Users\\test', APPDATA: 'C:\\Users\\test\\AppData\\Roaming' }

  it('resolves a single variable and converts slashes', () => {
    expect(resolvePath('${HOME}/Downloads', vars)).toBe('C:\\Users\\test\\Downloads')
  })

  it('resolves multiple variables', () => {
    expect(resolvePath('${HOME}/AppData/${HOME}', vars)).toBe('C:\\Users\\test\\AppData\\C:\\Users\\test')
  })

  it('converts forward slashes to backslashes', () => {
    expect(resolvePath('${APPDATA}/discord/Cache', vars)).toBe('C:\\Users\\test\\AppData\\Roaming\\discord\\Cache')
  })

  it('throws on unknown variable', () => {
    expect(() => resolvePath('${UNKNOWN}/foo', vars)).toThrow('Unknown template variable ${UNKNOWN}')
  })

  it('passes through paths without variables and still converts slashes', () => {
    expect(resolvePath('C:/Windows.old', vars)).toBe('C:\\Windows.old')
  })

  it('does not resolve $VAR without braces', () => {
    expect(resolvePath('$HOME/path', vars)).toBe('$HOME\\path')
  })

  it('does not resolve malformed ${} syntax', () => {
    expect(() => resolvePath('${}/path', vars)).not.toThrow()
    expect(resolvePath('${}/path', vars)).toBe('${}\\path')
  })

  it('does not recursively resolve nested variables', () => {
    const nestedVars = { HOME: '${APPDATA}', APPDATA: '/should-not-appear' }
    expect(resolvePath('${HOME}/test', nestedVars)).toBe('${APPDATA}\\test')
  })

  it('handles paths with literal dollar signs (Windows $PatchCache$)', () => {
    expect(resolvePath('${HOME}/Installer/$PatchCache$', vars)).toBe('C:\\Users\\test\\Installer\\$PatchCache$')
  })

  it('resolves variables with digits like PROGRAMFILES_X86', () => {
    const win32Vars = { ...vars, PROGRAMFILES_X86: 'C:\\Program Files (x86)' }
    expect(resolvePath('${PROGRAMFILES_X86}/Steam', win32Vars)).toBe('C:\\Program Files (x86)\\Steam')
  })
})

describe('buildCleanerPaths', () => {
  const minimalJson: RulesJsonSet = {
    system: {
      type: 'system',
      cleanTargets: [
        { path: '${HOME}/temp', subcategory: 'Temp', deepRecencyCheck: true },
        { path: 'C:/Windows/Temp', subcategory: 'System Temp', needsAdmin: true },
      ],
      singleFileTargets: [{ path: '${HOME}/dump.dmp', subcategory: 'Dump' }],
    },
    browsers: {
      type: 'browsers',
      chromiumCacheDirs: {
        profile: [
          { dir: 'Cache', label: 'Cache' },
          { dir: 'Code Cache', label: 'Code Cache' },
          { dir: 'GpuCache', label: 'GPU Cache' },
          { dir: 'Service Worker/CacheStorage', label: 'Service Worker Cache' },
        ],
        shared: [{ dir: 'GrShaderCache', label: 'Skia Shader Cache' }],
      },
      chromium: [
        { key: 'chrome', base: '${LOCALAPPDATA}/Google/Chrome' },
      ],
      firefox: { base: '${APPDATA}/Mozilla/Firefox', cache: '${LOCALAPPDATA}/Mozilla/Firefox' },
      safari: null,
    },
    apps: {
      type: 'apps',
      apps: [
        { id: 'discord', name: 'Discord', paths: ['${APPDATA}/discord/Cache'], group: 'Messaging', minAgeDays: 1 },
        { id: 'jetbrains', name: 'JetBrains', paths: ['${LOCALAPPDATA}/JetBrains'], childSubdir: 'caches' },
        { id: 'webview', name: 'WebView', paths: ['${LOCALAPPDATA}'], recursiveMatch: { anchor: 'EBWebView', targets: ['Cache'], maxDepth: 8 } },
        { id: 'updaters', name: 'Updaters', paths: ['${LOCALAPPDATA}'], fileMatch: { names: ['installer.exe'], childDirSuffix: '-updater', minAgeDays: 14, skipIfChildExists: ['pending'] } },
      ],
    },
    gaming: {
      type: 'gaming',
      apps: [{ id: 'steam', name: 'Steam', paths: ['${PROGRAMFILES_X86}/Steam/logs'] }],
    },
    gpuCache: {
      type: 'gpu-cache',
      apps: [{ id: 'nvidia', name: 'NVIDIA', paths: ['${LOCALAPPDATA}/NVIDIA'] }],
    },
    steam: {
      type: 'steam',
      libraries: ['${PROGRAMFILES_X86}/Steam/steamapps'],
      redistPatterns: ['_CommonRedist', 'vcredist'],
    },
    databases: {
      type: 'databases',
      sharedDbFileSets: {
        chromium: ['History', 'Cookies', 'Network/Cookies'],
      },
      targets: [
        { label: 'Chrome', basePath: '${LOCALAPPDATA}/Google/Chrome', dbFiles: '$chromium', multiProfile: true },
        { label: 'Discord', basePath: '${APPDATA}/discord', dbFiles: ['Network/Cookies'] },
      ],
    },
    misc: {
      type: 'misc',
      protectedEventLogs: [],
      trashPath: '${HOME}/$Recycle.Bin',
    },
  }

  const paths = buildCleanerPaths(minimalJson)

  it('resolves systemCleanTargets', () => {
    const targets = paths.systemCleanTargets()
    expect(targets).toHaveLength(2)
    expect(targets[0].path).toContain('\\temp')
    expect(targets[0].deepRecencyCheck).toBe(true)
    expect(targets[1].needsAdmin).toBe(true)
  })

  it('resolves singleFileCleanTargets', () => {
    const targets = paths.singleFileCleanTargets()
    expect(targets).toHaveLength(1)
    expect(targets[0].subcategory).toBe('Dump')
  })

  it('resolves browserPaths with chromium cache dirs', () => {
    const bp = paths.browserPaths()
    expect(bp.chrome.profileCaches).toContainEqual({ dir: 'Cache', label: 'Cache' })
    expect(bp.chrome.sharedCaches).toEqual([{ dir: 'GrShaderCache', label: 'Skia Shader Cache' }])
    expect(bp.chrome.base.toLowerCase()).toContain('chrome')
    expect(bp.firefox.base.toLowerCase()).toContain('firefox')
    expect(bp.safari).toBeNull()
  })

  it('defaults sharedCaches to an empty list when the rules omit it', () => {
    const noShared = {
      ...minimalJson,
      browsers: {
        ...minimalJson.browsers,
        chromiumCacheDirs: { profile: [{ dir: 'Cache', label: 'Cache' }] },
      },
    }
    expect(buildCleanerPaths(noShared).browserPaths().chrome.sharedCaches).toEqual([])
  })

  it('resolves appPaths with indirect path matchers', () => {
    const apps = paths.appPaths()
    expect(apps).toHaveLength(4)
    expect(apps[0].group).toBe('Messaging')
    expect(apps[0].minAgeDays).toBe(1)
    expect(apps[1].childSubdir).toBe('caches')
    expect(apps[2].recursiveMatch).toEqual({ anchor: 'EBWebView', targets: ['Cache'], maxDepth: 8 })
    expect(apps[3].fileMatch).toEqual({ names: ['installer.exe'], childDirSuffix: '-updater', minAgeDays: 14, skipIfChildExists: ['pending'] })
  })

  it('resolves gamingPaths', () => {
    expect(paths.gamingPaths()).toHaveLength(1)
  })

  it('resolves gpuCachePaths', () => {
    expect(paths.gpuCachePaths()).toHaveLength(1)
  })

  it('resolves steamLibraries and redistPatterns', () => {
    expect(paths.steamLibraries()).toHaveLength(1)
    expect(paths.steamRedistPatterns()).toContain('_CommonRedist')
  })

  it('resolves trashPath', () => {
    expect(paths.trashPath()).toContain('$Recycle.Bin')
  })

  it('resolves databaseOptimizeTargets with shared sets', () => {
    const targets = paths.databaseOptimizeTargets()
    expect(targets).toHaveLength(2)
    expect(targets[0].dbFiles).toEqual(['History', 'Cookies', 'Network\\Cookies'])
    expect(targets[0].multiProfile).toBe(true)
    expect(targets[1].dbFiles).toEqual(['Network\\Cookies'])
  })

  it('throws on unknown sharedDbFileSets reference', () => {
    const badJson = {
      ...minimalJson,
      databases: {
        type: 'databases' as const,
        sharedDbFileSets: {},
        targets: [{ label: 'Bad', basePath: 'C:\\Temp', dbFiles: '$nonexistent' }],
      },
    }
    const badPaths = buildCleanerPaths(badJson)
    expect(() => badPaths.databaseOptimizeTargets()).toThrow("Unknown sharedDbFileSets reference '$nonexistent'")
  })
})
