import { app, BrowserWindow, ipcMain, Menu, nativeImage, screen, shell, Tray } from 'electron'
import { randomUUID } from 'crypto'
import { join } from 'path'

import { execNativeUtf8, killAllChildren } from './services/exec-utf8'
import { IPC } from '../shared/channels'
import { t } from './i18n'
import { registerCleanerIpc } from './ipc'
import { getSettings } from './services/settings-store'
import { loadWindowState, trackWindowState, MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT } from './services/window-state'
import { startScheduler, stopScheduler, getNextScanTime, notifyScheduledScanComplete, completeScheduleRun } from './services/scheduler'
import { initAutoUpdater } from './services/auto-updater'
import { attachRendererDiagnostics } from './services/renderer-diagnostics'
import { shouldDisableGpu, applyGpuFallbackSwitches, registerGpuCrashRecovery } from './services/gpu-fallback'
import { runCli } from './cli'
import { createWindowsTrayIcon } from './tray-icon'

// ─── Disable hardware acceleration ──────────────────────────
// Must be called before app.whenReady().  On machines with incompatible
// GPU drivers, broken ANGLE, or certain VM setups, Chromium's GPU
// compositor silently fails — resulting in a black window that the user
// can resize but never see content in.  For a system-cleaner utility the
// visual trade-off (software compositing) is negligible.
app.disableHardwareAcceleration()

// ─── Data directory override ────────────────────────────────
const dataDirFlag = process.argv.find(a => a.startsWith('--ertcleaner-data-dir='))
if (dataDirFlag) {
  const dir = dataDirFlag.slice('--ertcleaner-data-dir='.length)
  if (dir && require('path').isAbsolute(dir)) {
    app.setPath('userData', dir)
  }
}

// ─── GPU process fallback ───────────────────────────────────
// disableHardwareAcceleration() still spawns a GPU process; on stripped
// Windows builds that process fails to launch and Chromium fatally aborts
// (issue #203).  If a prior launch hit that, or the user opted in, fully
// disable the GPU process.  Otherwise watch for the failure and recover by
// relaunching with --disable-gpu.  Placed after the data-dir override so
// the marker is read from the correct userData path.
if (shouldDisableGpu()) {
  applyGpuFallbackSwitches()
} else {
  registerGpuCrashRecovery()
}

// ─── CLI mode ────────────────────────────────────────────────
// If --cli is passed, run headless and exit — no GUI, no tray.
if (process.argv.includes('--cli')) {
  app.whenReady().then(() => runCli())
} else {
  initGui()
}

function initGui(): void {

// Prevent multiple instances — if another is already running, focus it and quit this one
// Development previews can run alongside an installed ErtCleaner copy. Packaged
// builds keep the normal single-instance guarantee.
const gotLock = app.isPackaged ? app.requestSingleInstanceLock() : true
if (!gotLock) {
  app.quit()
  return
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let ipcRegistered = false
// Set once the app is actually quitting (Cmd+Q, tray Quit, OS shutdown) so the
// minimize-to-tray close interceptor lets windows close instead of aborting quit
let isQuitting = false

function getIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.ico')
    : join(__dirname, '../../resources/icon.ico')
}

function getIconsDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icons')
    : join(__dirname, '../../resources/icons')
}

function createTrayIcon(): Electron.NativeImage {
  return createWindowsTrayIcon(nativeImage, join(getIconsDir(), 'tray'))
}

const TASK_NAME = 'ErtCleanerStartup'
/** The only arguments the startup task is allowed to carry — verified after registration. */
const TASK_ARGUMENTS = '--startup'

async function applyAutoLaunchWin32(enabled: boolean): Promise<void> {
  // Use Task Scheduler with RunLevel HighestAvailable so the app starts
  // elevated at logon. The HKCU Run key is NOT a viable fallback because
  // the exe manifest is requireAdministrator — Windows silently skips
  // Run-key entries for executables with an admin manifest.
  const exePath = app.getPath('exe')

  if (enabled) {
    // Remove any stale task first, then create a fresh one
    try {
      await execNativeUtf8('schtasks',[
        '/Delete', '/TN', TASK_NAME, '/F'
      ], { timeout: 10000 })
    } catch { /* task may not exist yet */ }

    // Build the task via XML so the /TR value is never subject to
    // schtasks command-line quoting quirks (common cause of silent failures
    // when the exe path contains spaces, e.g. "C:\Program Files\...").
    const xml = [
      '<?xml version="1.0" encoding="UTF-16"?>',
      '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
      '  <Triggers>',
      '    <LogonTrigger><Enabled>true</Enabled></LogonTrigger>',
      '    <SessionStateChangeTrigger>',
      '      <Enabled>true</Enabled>',
      '      <StateChange>ConsoleConnect</StateChange>',
      '    </SessionStateChangeTrigger>',
      '  </Triggers>',
      '  <Principals>',
      '    <Principal id="Author">',
      '      <LogonType>InteractiveToken</LogonType>',
      '      <RunLevel>HighestAvailable</RunLevel>',
      '    </Principal>',
      '  </Principals>',
      '  <Settings>',
      '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
      '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
      '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
      '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
      '    <Enabled>true</Enabled>',
      '  </Settings>',
      '  <Actions Context="Author">',
      `    <Exec>`,
      `      <Command>${escapeXml(exePath)}</Command>`,
      `      <Arguments>${escapeXml(TASK_ARGUMENTS)}</Arguments>`,
      '    </Exec>',
      '  </Actions>',
      '</Task>'
    ].join('\r\n')

    // The XML lands in %LOCALAPPDATA%\Temp, which any process running as this
    // user can write \u2014 including a non-elevated one. Since schtasks reads it
    // back elevated and the task carries RunLevel HighestAvailable, a swap
    // between our write and its read would register an attacker's command as a
    // logon-triggered admin task. A random name denies the attacker a path to
    // camp on, and the post-registration check below is what actually settles
    // it: whatever ends up registered has to be the command we asked for.
    const { writeFile, unlink, mkdtemp, rmdir } = await import('fs/promises')
    const tmpDir = await mkdtemp(join(app.getPath('temp'), 'ertcleaner-task-'))
    const tmpPath = join(tmpDir, `${randomUUID()}.xml`)
    await writeFile(tmpPath, '\uFEFF' + xml, 'utf-16le')

    try {
      await execNativeUtf8('schtasks',[
        '/Create',
        '/TN', TASK_NAME,
        '/XML', tmpPath,
        '/F',
      ], { timeout: 10000 })
    } finally {
      await unlink(tmpPath).catch(() => {})
      await rmdir(tmpDir).catch(() => {})
    }

    // Verify what was actually registered, not merely that something was.
    // If the definition isn't the one we submitted, the XML was tampered with
    // in the window above \u2014 tear the task down rather than leave an elevated
    // logon entry running something else.
    //
    // A query that fails or times out is also a failure to verify, and is
    // treated the same way: an unverified elevated logon task must not survive
    // this function, whatever the reason we couldn't check it.
    let verified = false
    try {
      const { stdout: registered } = await execNativeUtf8('schtasks',[
        '/Query', '/TN', TASK_NAME, '/XML', 'ONE'
      ], { timeout: 10000 })
      verified = registeredTaskMatches(registered, exePath, TASK_ARGUMENTS)
    } catch { /* treated as unverified below */ }

    if (!verified) {
      await execNativeUtf8('schtasks',[
        '/Delete', '/TN', TASK_NAME, '/F'
      ], { timeout: 10000 }).catch(() => {})
      throw new Error('Startup task verification failed \u2014 the registered task did not match')
    }
  } else {
    try {
      await execNativeUtf8('schtasks',[
        '/Delete', '/TN', TASK_NAME, '/F'
      ], { timeout: 10000 })
    } catch { /* task may not exist */ }
  }

  // Clear any leftover Electron Run-key entry so it doesn't conflict
  app.setLoginItemSettings({ openAtLogin: false })
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Is the registered task definition exactly the one we asked for?
 *
 * Task Scheduler runs the whole <Actions> block at HighestAvailable, so
 * matching the command alone is not enough. Arguments decide what that command
 * does — `--inspect-brk` would turn our own binary into arbitrary elevated code
 * execution — and a definition may carry action types other than Exec
 * (ComHandler, SendEmail, ShowMessage) that run without naming a command at
 * all. So this requires precisely one Exec action, the expected command, the
 * expected arguments, and no other action of any kind.
 *
 * Returns false on anything it cannot account for, so an unparseable or empty
 * read is a failed verification rather than a pass.
 */
function registeredTaskMatches(taskXml: string, exePath: string, expectedArgs: string): boolean {
  const actionsBlock = taskXml.match(/<Actions\b[^>]*>([\s\S]*?)<\/Actions>/i)
  if (!actionsBlock) return false
  const actions = actionsBlock[1]

  // Any element directly under <Actions> is an action. Exactly one, and it
  // must be an Exec.
  const actionTags = [...actions.matchAll(/<([A-Za-z][\w.-]*)\b/g)]
    .map((m) => m[1])
    .filter((tag) => !TASK_EXEC_CHILD_TAGS.has(tag))
  if (actionTags.length !== 1 || actionTags[0].toLowerCase() !== 'exec') return false

  const commands = [...actions.matchAll(/<Command>([\s\S]*?)<\/Command>/gi)]
  if (commands.length !== 1) return false
  const command = decodeXmlEntities(commands[0][1].trim().replace(/^"|"$/g, '')).toLowerCase()
  if (command !== exePath.trim().toLowerCase()) return false

  // Arguments may legitimately be absent only if we asked for none.
  const argMatches = [...actions.matchAll(/<Arguments>([\s\S]*?)<\/Arguments>/gi)]
  if (argMatches.length > 1) return false
  const args = argMatches.length === 1 ? decodeXmlEntities(argMatches[0][1].trim()) : ''
  return args === expectedArgs.trim()
}

/** Elements that appear *inside* an Exec action rather than being actions themselves. */
const TASK_EXEC_CHILD_TAGS = new Set(['Command', 'Arguments', 'WorkingDirectory'])

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

async function applyAutoLaunch(enabled: boolean): Promise<void> {
  // Only register auto-launch when packaged — in dev mode this would register
  // the bare Electron binary, causing a generic "Getting Started" window on reboot.
  if (!app.isPackaged) return
  await applyAutoLaunchWin32(enabled)
}

function createTray(): void {
  if (tray) return

  tray = new Tray(createTrayIcon())
  tray.setToolTip(t('trayTooltip'))

  const contextMenu = Menu.buildFromTemplate([
    {
      label: t('openErtCleaner'),
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show()
          mainWindow.focus()
        } else {
          createWindow()
        }
      }
    },
    { type: 'separator' },
    {
      label: t('quit'),
      click: () => {
        app.quit()
      }
    }
  ])

  tray.setContextMenu(contextMenu)
  tray.on('double-click', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show()
      mainWindow.focus()
    } else {
      createWindow()
    }
  })
}

/** Rebuild the tray context menu (e.g. after a language change) */
function rebuildTrayMenu(): void {
  if (!tray) return
  tray.setToolTip(t('trayTooltip'))
  const contextMenu = Menu.buildFromTemplate([
    {
      label: t('openErtCleaner'),
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show()
          mainWindow.focus()
        } else {
          createWindow()
        }
      }
    },
    { type: 'separator' },
    {
      label: t('quit'),
      click: () => {
        app.quit()
      }
    }
  ])
  tray.setContextMenu(contextMenu)
}

function destroyTray(): void {
  if (tray) {
    tray.destroy()
    tray = null
  }
}

const ALLOWED_EXTERNAL_HOSTS = new Set([
  'buymeacoffee.com',
  'www.buymeacoffee.com',
])

function createWindow(): void {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize
  const defaultWidth = Math.round(screenWidth * 0.75)
  const defaultHeight = Math.round(screenHeight * 0.8)

  // Reopen at the size/position the user left the window at (issue #270).
  const { width, height, x, y, isMaximized } = loadWindowState({
    width: defaultWidth,
    height: defaultHeight
  })

  const icon = nativeImage.createFromPath(getIconPath())

  mainWindow = new BrowserWindow({
    width,
    height,
    // Omitted when no saved position survived validation, so Electron centres.
    ...(x !== undefined && y !== undefined ? { x, y } : {}),
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: '#e8e8ea',
      height: 48
    },
    backgroundMaterial: 'mica' as const,
    roundedCorners: true,
    backgroundColor: '#00000000',
    icon,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // Respect the user's Windows accent preference for the native active-window border.
  mainWindow.setAccentColor(true)

  // Maximize before first paint so the window never flashes at its restored
  // size; getNormalBounds() keeps the un-maximized geometry for later.
  if (isMaximized) mainWindow.maximize()

  trackWindowState(mainWindow)

  const settings = getSettings()
  // Detect startup launch via the --startup flag (Windows Task Scheduler).
  const isStartupLaunch = process.argv.includes('--startup')

  attachRendererDiagnostics(mainWindow)

  mainWindow.on('ready-to-show', () => {
    // If launched at startup with minimize-to-tray, stay hidden
    if (isStartupLaunch && settings.minimizeToTray) {
      // Don't show — just sit in tray
    } else {
      mainWindow?.show()
    }
  })

  // Intercept close to minimize to tray if enabled
  mainWindow.on('close', (e) => {
    if (isQuitting) return
    const currentSettings = getSettings()
    if (currentSettings.minimizeToTray && mainWindow && !mainWindow.isDestroyed()) {
      e.preventDefault()
      mainWindow.hide()
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    try {
      const url = new URL(details.url)
      if (url.protocol === 'https:' && ALLOWED_EXTERNAL_HOSTS.has(url.hostname.toLowerCase())) {
        void shell.openExternal(url.toString())
      }
    } catch {
      // Invalid URL, ignore
    }
    return { action: 'deny' }
  })

  // Register IPC handlers only once to avoid stacking on window recreation
  if (!ipcRegistered) {
    // Window control IPC — use current mainWindow reference
    ipcMain.on(IPC.WINDOW_MINIMIZE, () => mainWindow?.minimize())
    ipcMain.on(IPC.WINDOW_MAXIMIZE, () => {
      if (mainWindow?.isMaximized()) {
        mainWindow.unmaximize()
      } else {
        mainWindow?.maximize()
      }
    })
    ipcMain.on(IPC.WINDOW_CLOSE, () => mainWindow?.close())
    ipcMain.on(IPC.WINDOW_SET_CHROME_THEME, (_event, theme: unknown) => {
      if (theme !== 'light' && theme !== 'dark') return
      mainWindow?.setTitleBarOverlay({
        color: '#00000000',
        symbolColor: theme === 'light' ? '#1a1a1c' : '#e8e8ea',
        height: 48
      })
    })

    // Register all IPC handlers (pass getter so handlers always use current window)
    registerCleanerIpc(() => mainWindow)

    ipcRegistered = true
  }

  // Load the app
  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    if (!mainWindow.isVisible()) mainWindow.show()
    mainWindow.focus()
  }
})

app.whenReady().then(() => {
  // Ensure an Edit menu exists so clipboard shortcuts (Ctrl+C/V/X) work
  // in the frameless window.
  const appMenu = Menu.buildFromTemplate([
    { role: 'appMenu' },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    }
  ])
  Menu.setApplicationMenu(appMenu)

  const settings = getSettings()

  // Apply auto-launch setting
  applyAutoLaunch(settings.runAtStartup).catch((err) => {
    console.error('Failed to configure auto-launch:', err)
  })

  // Create tray if minimize-to-tray is enabled or any schedule is active
  if (settings.minimizeToTray || settings.schedules.some((s) => s.enabled)) {
    createTray()
  }

  createWindow()

  // Initialize auto-updater
  initAutoUpdater()

  // Start the scheduled scan checker
  startScheduler(() => mainWindow)

  // Listen for settings changes to update auto-launch and tray
  ipcMain.handle(IPC.SETTINGS_APPLY_STARTUP, async (_event, enabled: boolean) => {
    await applyAutoLaunch(enabled)
  })

  ipcMain.on(IPC.SETTINGS_APPLY_TRAY, (_event, enabled: boolean) => {
    if (enabled) {
      createTray()
    } else if (!getSettings().schedules.some((s) => s.enabled)) {
      destroyTray()
    }
  })

  // Rebuild tray menu when language changes so labels update immediately
  app.on('ertcleaner:language-changed' as any, () => {
    rebuildTrayMenu()
  })

  // IPC to get next scan time for the UI
  ipcMain.handle(IPC.SCHEDULE_NEXT_SCAN, () => {
    const s = getSettings()
    const next = getNextScanTime(s)
    return next ? next.toISOString() : null
  })

  // Handle scheduled scan completion notification from renderer
  ipcMain.on(IPC.SCHEDULE_SCAN_COMPLETE, (_event, totalSize: number, itemCount: number) => {
    notifyScheduledScanComplete(totalSize, itemCount)
  })

  // Handle multi-schedule run completion
  const VALID_RUN_STATUSES = new Set(['success', 'partial', 'failed', 'never'])
  ipcMain.on(IPC.SCHEDULE_RUN_COMPLETE, (_event, scheduleId: unknown, status: unknown) => {
    if (typeof scheduleId !== 'string' || typeof status !== 'string') return
    if (!VALID_RUN_STATUSES.has(status)) return
    completeScheduleRun(scheduleId, status as 'success' | 'partial' | 'failed' | 'never')
  })

  app.on('activate', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      // Window exists but may be hidden (minimize-to-tray) — restore it
      mainWindow.show()
      mainWindow.focus()
    } else if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  const settings = getSettings()
  // Don't quit if minimize-to-tray or any schedule is enabled
  if (settings.minimizeToTray || settings.schedules.some((s) => s.enabled)) {
    // Stay alive in tray
    return
  }
  app.quit()
})

// On macOS, autoUpdater.quitAndInstall() closes all windows *before* emitting
// before-quit, so mark quitting from this earlier signal too
app.on('before-quit-for-update', () => {
  isQuitting = true
})

app.on('before-quit', () => {
  isQuitting = true
  stopScheduler()
  // Kill any active child processes (reg.exe, cmd.exe, etc.) to prevent orphans
  killAllChildren()
})

} // end initGui
