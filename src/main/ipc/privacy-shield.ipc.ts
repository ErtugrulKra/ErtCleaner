import { BrowserWindow, ipcMain, app } from 'electron'
import { execFile } from 'child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { IPC } from '../../shared/channels'
import type {
  PrivacySetting,
  PrivacyShieldState,
  PrivacyApplyResult
} from '../../shared/types'
import type { WindowGetter } from './index'
import { getPlatform } from '../platform'
import { validateStringArray } from '../services/ipc-validation'
import { execNativeUtf8 } from '../services/exec-utf8'

const execFileAsync = promisify(execFile)

// Hard timeout wrapper — guarantees a check never hangs forever
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms))
  ])
}

// ─── Setting definitions ─────────────────────────────────────
// Each entry describes what "enabled = true" means for privacy
// (i.e. the privacy-friendly state).

interface SettingDef {
  id: string
  category: PrivacySetting['category']
  label: string
  description: string
  requiresAdmin: boolean
  dependsOn?: string                  // ID of a setting that must be enabled first
  check: () => Promise<boolean>       // returns true if already privacy-friendly
  apply: () => Promise<void>          // applies the privacy-friendly state
  revert?: () => Promise<void>        // reverts to Windows default (unprotected)
  applicable?: () => Promise<boolean> // returns false if the underlying resource doesn't exist (e.g. browser not installed, task missing)
}

// ── Helpers ────────────────────────────────────────────────

async function regQueryDword(key: string, value: string): Promise<number | null> {
  try {
    const { stdout } = await execNativeUtf8('reg',['query', key, '/v', value], { timeout: 5000, windowsHide: true })
    const match = stdout.match(new RegExp(`${value}\\s+REG_DWORD\\s+0x([0-9a-fA-F]+)`, 'i'))
    return match ? parseInt(match[1], 16) : null
  } catch {
    return null
  }
}

async function regSetDword(key: string, value: string, data: number): Promise<void> {
  await execNativeUtf8('reg',['add', key, '/v', value, '/t', 'REG_DWORD', '/d', String(data), '/f'], { timeout: 5000, windowsHide: true })
}

async function isTaskActive(taskPath: string): Promise<boolean> {
  try {
    const { stdout } = await execNativeUtf8('schtasks',['/query', '/tn', taskPath, '/xml'], { timeout: 8000, windowsHide: true })
    // XML <Enabled> element is language-independent (always "true"/"false"),
    // unlike CSV status which is localized (e.g. "Désactivé" on French Windows).
    // Match only the <Enabled> inside <Settings>, not trigger-level <Enabled> elements.
    const m = stdout.match(/<Settings>[\s\S]*?<Enabled>(true|false)<\/Enabled>[\s\S]*?<\/Settings>/i)
    if (m) return m[1].toLowerCase() === 'true'
    return true
  } catch {
    return false // task doesn't exist
  }
}

async function taskExists(taskPath: string): Promise<boolean> {
  try {
    await execNativeUtf8('schtasks',['/query', '/tn', taskPath, '/fo', 'CSV', '/nh'], { timeout: 8000, windowsHide: true })
    return true
  } catch {
    return false
  }
}

async function serviceExists(serviceName: string): Promise<boolean> {
  const val = await regQueryDword(`HKLM\\SYSTEM\\CurrentControlSet\\Services\\${serviceName}`, 'Start')
  return val !== null
}

async function disableTask(taskPath: string): Promise<void> {
  await execNativeUtf8('schtasks',['/change', '/tn', taskPath, '/disable'], { timeout: 5000, windowsHide: true })
}

async function enableTask(taskPath: string): Promise<void> {
  await execNativeUtf8('schtasks',['/change', '/tn', taskPath, '/enable'], { timeout: 5000, windowsHide: true })
}

// ─── Persistent service start-type cache ──────────────────────
// Stores the original Start type for each service before we disable it,
// so we can restore it properly on revert (e.g. Automatic=2 vs Manual=3).
// Persisted to disk so the cache survives app restarts.

function getServiceCachePath(): string {
  const dir = app.isPackaged
    ? app.getPath('userData')
    : join(app.getPath('userData'), 'ErtCleaner-Dev')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'service-start-types.json')
}

function loadServiceStartTypes(): Map<string, number> {
  try {
    const raw = readFileSync(getServiceCachePath(), 'utf-8')
    const obj = JSON.parse(raw)
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      return new Map(Object.entries(obj).filter(([, v]) => typeof v === 'number') as [string, number][])
    }
  } catch { /* file missing or corrupt — start fresh */ }
  return new Map()
}

function saveServiceStartTypes(cache: Map<string, number>): void {
  try {
    writeFileSync(getServiceCachePath(), JSON.stringify(Object.fromEntries(cache), null, 2))
  } catch { /* best-effort — non-fatal */ }
}

const originalServiceStartType = loadServiceStartTypes()

async function disableService(serviceName: string): Promise<void> {
  // Capture the original Start type before overwriting
  if (!originalServiceStartType.has(serviceName)) {
    const startVal = await regQueryDword(
      `HKLM\\SYSTEM\\CurrentControlSet\\Services\\${serviceName}`, 'Start'
    )
    if (startVal !== null && startVal !== 4) {
      originalServiceStartType.set(serviceName, startVal)
      saveServiceStartTypes(originalServiceStartType)
    }
  }
  await execNativeUtf8('reg',[
    'add', `HKLM\\SYSTEM\\CurrentControlSet\\Services\\${serviceName}`,
    '/v', 'Start', '/t', 'REG_DWORD', '/d', '4', '/f'
  ], { timeout: 5000, windowsHide: true })
}

async function enableService(serviceName: string): Promise<void> {
  const original = originalServiceStartType.get(serviceName) ?? 3 // default to Manual
  // Write the registry value first — only clear the cache after success so a
  // failed revert (e.g. access denied) doesn't lose the original start type.
  await execNativeUtf8('reg',[
    'add', `HKLM\\SYSTEM\\CurrentControlSet\\Services\\${serviceName}`,
    '/v', 'Start', '/t', 'REG_DWORD', '/d', String(original), '/f'
  ], { timeout: 5000, windowsHide: true })
  originalServiceStartType.delete(serviceName)
  saveServiceStartTypes(originalServiceStartType)
}

async function regDeleteValue(key: string, value: string): Promise<void> {
  try {
    await execNativeUtf8('reg',['delete', key, '/v', value, '/f'], { timeout: 5000, windowsHide: true })
  } catch (err: unknown) {
    // "not found" is the desired end state — swallow it.
    // Everything else (access denied, invalid key, etc.) must surface so
    // revertPrivacySettings can report the failure accurately.
    const msg = err instanceof Error ? err.message : ''
    const stderr = (err as { stderr?: string })?.stderr ?? ''
    const combined = msg + stderr
    if (combined.toLowerCase().includes('unable to find')) return
    throw err
  }
}

async function isBrowserInstalled(registryKey: string): Promise<boolean> {
  try {
    await execNativeUtf8('reg',['query', registryKey, '/ve'], { timeout: 5000, windowsHide: true })
    return true
  } catch {
    return false
  }
}

async function isServiceEnabled(serviceName: string): Promise<boolean> {
  const val = await regQueryDword(`HKLM\\SYSTEM\\CurrentControlSet\\Services\\${serviceName}`, 'Start')
  return val !== null && val !== 4 // 4 = disabled
}

function sendProgress(win: BrowserWindow | null, data: object): void {
  try {
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.PRIVACY_PROGRESS, data)
    }
  } catch {
    // Window may have been closed during scan
  }
}

// ─── All privacy settings ────────────────────────────────────

const SETTINGS: SettingDef[] = [
  // ─── TELEMETRY ───
  {
    id: 'telemetry-level',
    category: 'telemetry',
    label: 'Windows Telemetrisi',
    description: 'Tanılama verisi toplamayı en aza indirin (yalnızca Güvenlik düzeyi)',
    requiresAdmin: true,
    check: async () => {
      const val = await regQueryDword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\DataCollection', 'AllowTelemetry')
      return val === 0
    },
    apply: () => regSetDword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\DataCollection', 'AllowTelemetry', 0),
    revert: () => regDeleteValue('HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\DataCollection', 'AllowTelemetry')
  },
  {
    id: 'activity-history',
    category: 'telemetry',
    label: 'Etkinlik Geçmişi',
    description: 'Windows\'un uygulama ve dosya kullanımınızı izlemesini ve eşitlemesini durdurun',
    requiresAdmin: true,
    check: async () => {
      const val = await regQueryDword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\System', 'EnableActivityFeed')
      return val === 0
    },
    apply: () => regSetDword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\System', 'EnableActivityFeed', 0),
    revert: () => regDeleteValue('HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\System', 'EnableActivityFeed')
  },
  {
    id: 'publish-activity',
    category: 'telemetry',
    label: 'Kullanıcı Etkinliklerini Yayımlama',
    description: 'Windows\'un etkinliklerinizi Microsoft\'a yayımlamasını engelleyin',
    requiresAdmin: true,
    check: async () => {
      const val = await regQueryDword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\System', 'PublishUserActivities')
      return val === 0
    },
    apply: () => regSetDword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\System', 'PublishUserActivities', 0),
    revert: () => regDeleteValue('HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\System', 'PublishUserActivities')
  },
  {
    id: 'feedback-frequency',
    category: 'telemetry',
    label: 'Geri Bildirim İstekleri',
    description: 'Periyodik Microsoft geri bildirim isteklerini ve anketlerini devre dışı bırakın',
    requiresAdmin: false,
    check: async () => {
      const val = await regQueryDword('HKCU\\SOFTWARE\\Microsoft\\Siuf\\Rules', 'NumberOfSIUFInPeriod')
      return val === 0
    },
    apply: () => regSetDword('HKCU\\SOFTWARE\\Microsoft\\Siuf\\Rules', 'NumberOfSIUFInPeriod', 0),
    revert: () => regDeleteValue('HKCU\\SOFTWARE\\Microsoft\\Siuf\\Rules', 'NumberOfSIUFInPeriod')
  },
  {
    id: 'handwriting-telemetry',
    category: 'telemetry',
    label: 'El Yazısı Verileri',
    description: 'El yazısı ve yazma verilerinin Microsoft\'a gönderilmesini durdurun',
    requiresAdmin: false,
    check: async () => {
      const val = await regQueryDword('HKCU\\SOFTWARE\\Microsoft\\Input\\TIPC', 'Enabled')
      return val === 0
    },
    apply: () => regSetDword('HKCU\\SOFTWARE\\Microsoft\\Input\\TIPC', 'Enabled', 0),
    revert: () => regSetDword('HKCU\\SOFTWARE\\Microsoft\\Input\\TIPC', 'Enabled', 1)
  },
  {
    id: 'input-personalization',
    category: 'telemetry',
    label: 'Giriş Kişiselleştirme',
    description: 'Yazma ve mürekkep kişiselleştirme verisi toplamayı devre dışı bırakın',
    requiresAdmin: false,
    check: async () => {
      const val = await regQueryDword('HKCU\\SOFTWARE\\Microsoft\\Personalization\\Settings', 'AcceptedPrivacyPolicy')
      return val === 0
    },
    apply: () => regSetDword('HKCU\\SOFTWARE\\Microsoft\\Personalization\\Settings', 'AcceptedPrivacyPolicy', 0),
    revert: () => regSetDword('HKCU\\SOFTWARE\\Microsoft\\Personalization\\Settings', 'AcceptedPrivacyPolicy', 1)
  },
  {
    id: 'tailored-experiences',
    category: 'telemetry',
    label: 'Kişiselleştirilmiş Deneyimler',
    description: 'Microsoft\'un ipuçlarını ve reklamları kişiselleştirmek için tanılama verilerini kullanmasını durdurun',
    requiresAdmin: false,
    check: async () => {
      const val = await regQueryDword('HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Privacy', 'TailoredExperiencesWithDiagnosticDataEnabled')
      return val === 0
    },
    apply: () => regSetDword('HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Privacy', 'TailoredExperiencesWithDiagnosticDataEnabled', 0),
    revert: () => regSetDword('HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Privacy', 'TailoredExperiencesWithDiagnosticDataEnabled', 1)
  },
  {
    id: 'app-launch-tracking',
    category: 'telemetry',
    label: 'Uygulama Başlatma İzleme',
    description: 'Windows\'un Başlat menüsünü "iyileştirmek" için açtığınız uygulamaları izlemesini durdurun',
    requiresAdmin: false,
    check: async () => {
      const val = await regQueryDword('HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced', 'Start_TrackProgs')
      return val === 0
    },
    apply: () => regSetDword('HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced', 'Start_TrackProgs', 0),
    revert: () => regSetDword('HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced', 'Start_TrackProgs', 1)
  },

  // ─── ADS & SUGGESTIONS ───
  {
    id: 'advertising-id',
    category: 'ads',
    label: 'Reklam Kimliği',
    description: 'Uygulamaların sizi izlemek için kullandığı benzersiz reklam kimliğini devre dışı bırakın',
    requiresAdmin: false,
    check: async () => {
      const val = await regQueryDword('HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AdvertisingInfo', 'Enabled')
      return val === 0
    },
    apply: () => regSetDword('HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AdvertisingInfo', 'Enabled', 0),
    revert: () => regSetDword('HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AdvertisingInfo', 'Enabled', 1)
  },
  {
    id: 'suggested-content',
    category: 'ads',
    label: 'Ayarlar\'da Önerilen İçerik',
    description: 'Microsoft\'un Ayarlar\'da uygulama önerileri ve reklamlar göstermesini engelleyin',
    requiresAdmin: false,
    check: async () => {
      const val = await regQueryDword('HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager', 'SubscribedContent-338393Enabled')
      return val === 0
    },
    apply: () => regSetDword('HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager', 'SubscribedContent-338393Enabled', 0),
    revert: () => regSetDword('HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager', 'SubscribedContent-338393Enabled', 1)
  },
  {
    id: 'tips-notifications',
    category: 'ads',
    label: 'İpuçları ve Öneriler',
    description: 'Windows ipuçlarını, püf noktalarını ve öneri bildirimlerini devre dışı bırakın',
    requiresAdmin: false,
    check: async () => {
      const val = await regQueryDword('HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager', 'SubscribedContent-338389Enabled')
      return val === 0
    },
    apply: () => regSetDword('HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager', 'SubscribedContent-338389Enabled', 0),
    revert: () => regSetDword('HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager', 'SubscribedContent-338389Enabled', 1)
  },
  {
    id: 'start-suggestions',
    category: 'ads',
    label: 'Başlat Menüsü Önerileri',
    description: 'Başlat menüsündeki uygulama önerilerini (reklamları) devre dışı bırakın',
    requiresAdmin: false,
    check: async () => {
      const val = await regQueryDword('HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager', 'SystemPaneSuggestionsEnabled')
      return val === 0
    },
    apply: () => regSetDword('HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager', 'SystemPaneSuggestionsEnabled', 0),
    revert: () => regSetDword('HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager', 'SystemPaneSuggestionsEnabled', 1)
  },
  {
    id: 'lock-screen-spotlight',
    category: 'ads',
    label: 'Kilit Ekranı Spotlight',
    description: 'Kilit ekranındaki Microsoft Spotlight reklamlarını ve önerilerini devre dışı bırakın',
    requiresAdmin: false,
    check: async () => {
      const val = await regQueryDword('HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager', 'RotatingLockScreenEnabled')
      return val === 0
    },
    apply: () => regSetDword('HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager', 'RotatingLockScreenEnabled', 0),
    revert: () => regSetDword('HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager', 'RotatingLockScreenEnabled', 1)
  },
  {
    id: 'silently-installed-apps',
    category: 'ads',
    label: 'Sessizce Yüklenen Uygulamalar',
    description: 'Windows\'un tanıtılan uygulamaları otomatik yüklemesini engelleyin',
    requiresAdmin: false,
    check: async () => {
      const val = await regQueryDword('HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager', 'SilentInstalledAppsEnabled')
      return val === 0
    },
    apply: () => regSetDword('HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager', 'SilentInstalledAppsEnabled', 0),
    revert: () => regSetDword('HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager', 'SilentInstalledAppsEnabled', 1)
  },
  {
    id: 'preinstalled-apps',
    category: 'ads',
    label: 'Önceden Yüklü Uygulama Önerileri',
    description: 'Windows\'un kullanmadığınız önceden yüklü uygulamaları önermesini durdurun',
    requiresAdmin: false,
    check: async () => {
      const val = await regQueryDword('HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager', 'PreInstalledAppsEnabled')
      return val === 0
    },
    apply: () => regSetDword('HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager', 'PreInstalledAppsEnabled', 0),
    revert: () => regSetDword('HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager', 'PreInstalledAppsEnabled', 1)
  },

  // ─── SEARCH ───
  {
    id: 'bing-start-menu',
    category: 'search',
    label: 'Başlat Menüsünde Bing',
    description: 'Arama sorgularının Başlat menüsü üzerinden Bing\'e gönderilmesini durdurun',
    requiresAdmin: false,
    check: async () => {
      const val = await regQueryDword('HKCU\\SOFTWARE\\Policies\\Microsoft\\Windows\\Explorer', 'DisableSearchBoxSuggestions')
      return val === 1
    },
    apply: () => regSetDword('HKCU\\SOFTWARE\\Policies\\Microsoft\\Windows\\Explorer', 'DisableSearchBoxSuggestions', 1),
    revert: () => regDeleteValue('HKCU\\SOFTWARE\\Policies\\Microsoft\\Windows\\Explorer', 'DisableSearchBoxSuggestions')
  },
  {
    id: 'bing-web-search',
    category: 'search',
    label: 'Bing Web Sonuçları',
    description: 'Windows Arama\'daki web sonuçlarını devre dışı bırakın — aramaları yalnızca yerel tutun',
    requiresAdmin: false,
    check: async () => {
      const val = await regQueryDword('HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Search', 'BingSearchEnabled')
      return val === 0
    },
    apply: () => regSetDword('HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Search', 'BingSearchEnabled', 0),
    revert: () => regSetDword('HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Search', 'BingSearchEnabled', 1)
  },
  {
    id: 'cortana',
    category: 'search',
    label: 'Cortana',
    description: 'Cortana\'yı devre dışı bırakın — arka plan kaynak kullanımını ve veri toplamayı durdurur',
    requiresAdmin: true,
    check: async () => {
      const val = await regQueryDword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Windows Search', 'AllowCortana')
      return val === 0
    },
    apply: () => regSetDword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Windows Search', 'AllowCortana', 0),
    revert: () => regDeleteValue('HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Windows Search', 'AllowCortana')
  },
  {
    id: 'search-highlights',
    category: 'search',
    label: 'Arama Öne Çıkanları',
    description: 'Arama kutusundaki trend arama önerilerini ve web içeriğini devre dışı bırakın',
    requiresAdmin: false,
    check: async () => {
      const val = await regQueryDword('HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\SearchSettings', 'IsDynamicSearchBoxEnabled')
      return val === 0
    },
    apply: () => regSetDword('HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\SearchSettings', 'IsDynamicSearchBoxEnabled', 0),
    revert: () => regSetDword('HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\SearchSettings', 'IsDynamicSearchBoxEnabled', 1)
  },

  {
    id: 'store-search-suggestions',
    category: 'search',
    label: 'Store Arama Önerileri',
    description: 'Sorguları Microsoft\'a gönderen Microsoft Store arama önerilerini devre dışı bırakın',
    requiresAdmin: true,
    check: async () => {
      const val = await regQueryDword('HKLM\\SOFTWARE\\Policies\\Microsoft\\WindowsStore', 'DisableStoreSearchSuggestions')
      return val === 1
    },
    apply: () => regSetDword('HKLM\\SOFTWARE\\Policies\\Microsoft\\WindowsStore', 'DisableStoreSearchSuggestions', 1),
    revert: () => regDeleteValue('HKLM\\SOFTWARE\\Policies\\Microsoft\\WindowsStore', 'DisableStoreSearchSuggestions')
  },

  // ─── SYNC & CLOUD ───
  {
    id: 'clipboard-sync',
    category: 'sync',
    label: 'Pano Bulut Eşitlemesi',
    description: 'Pano verilerinin bulut üzerinden cihazlar arasında eşitlenmesini engelleyin',
    requiresAdmin: true,
    check: async () => {
      const val = await regQueryDword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\System', 'AllowCrossDeviceClipboard')
      return val === 0
    },
    apply: () => regSetDword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\System', 'AllowCrossDeviceClipboard', 0),
    revert: () => regDeleteValue('HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\System', 'AllowCrossDeviceClipboard')
  },
  {
    id: 'clipboard-history',
    category: 'sync',
    label: 'Pano Geçmişi',
    description: 'Kopyalanan metin ve görüntüleri saklayan pano geçmişini devre dışı bırakın',
    requiresAdmin: false,
    check: async () => {
      const val = await regQueryDword('HKCU\\SOFTWARE\\Microsoft\\Clipboard', 'EnableClipboardHistory')
      return val === 0
    },
    apply: () => regSetDword('HKCU\\SOFTWARE\\Microsoft\\Clipboard', 'EnableClipboardHistory', 0),
    revert: () => regSetDword('HKCU\\SOFTWARE\\Microsoft\\Clipboard', 'EnableClipboardHistory', 1)
  },
  {
    id: 'settings-sync',
    category: 'sync',
    label: 'Ayar Eşitleme',
    description: 'Windows ayarlarının, temaların ve parolaların Microsoft hesabınıza eşitlenmesini durdurun',
    requiresAdmin: true,
    check: async () => {
      const val = await regQueryDword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\SettingSync', 'DisableSettingSync')
      return val === 2
    },
    apply: () => regSetDword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\SettingSync', 'DisableSettingSync', 2),
    revert: () => regDeleteValue('HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\SettingSync', 'DisableSettingSync')
  },
  {
    id: 'find-my-device',
    category: 'sync',
    label: 'Cihazımı Bul',
    description: 'Microsoft\'un konum tabanlı cihaz izlemesini devre dışı bırakın',
    requiresAdmin: true,
    check: async () => {
      const val = await regQueryDword('HKLM\\SOFTWARE\\Microsoft\\MdmCommon\\SettingValues', 'LocationSyncEnabled')
      return val === 0
    },
    apply: () => regSetDword('HKLM\\SOFTWARE\\Microsoft\\MdmCommon\\SettingValues', 'LocationSyncEnabled', 0),
    revert: () => regSetDword('HKLM\\SOFTWARE\\Microsoft\\MdmCommon\\SettingValues', 'LocationSyncEnabled', 1)
  },

  // ─── AI FEATURES ───
  {
    id: 'copilot',
    category: 'ai',
    label: 'Microsoft Copilot',
    description: 'Windows genelinde Microsoft Copilot yapay zeka asistanını devre dışı bırakın',
    requiresAdmin: true,
    check: async () => {
      const val = await regQueryDword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsCopilot', 'TurnOffWindowsCopilot')
      return val === 1
    },
    apply: () => regSetDword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsCopilot', 'TurnOffWindowsCopilot', 1),
    revert: () => regDeleteValue('HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsCopilot', 'TurnOffWindowsCopilot')
  },
  {
    id: 'windows-recall',
    category: 'ai',
    label: 'Windows Recall',
    description: 'Ekrandaki her şeyi yakalayan Windows Recall yapay zeka ekran görüntüsü geçmişini devre dışı bırakın',
    requiresAdmin: true,
    check: async () => {
      const val = await regQueryDword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsAI', 'DisableAIDataAnalysis')
      return val === 1
    },
    apply: () => regSetDword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsAI', 'DisableAIDataAnalysis', 1),
    revert: () => regDeleteValue('HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsAI', 'DisableAIDataAnalysis')
  },
  {
    id: 'click-to-do',
    category: 'ai',
    label: 'Click To Do',
    description: 'Ekran içeriğinde Click To Do yapay zeka metin ve görüntü analizini devre dışı bırakın',
    requiresAdmin: true,
    check: async () => {
      const val = await regQueryDword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsAI', 'DisableClickToDo')
      return val === 1
    },
    apply: () => regSetDword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsAI', 'DisableClickToDo', 1),
    revert: () => regDeleteValue('HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsAI', 'DisableClickToDo')
  },
  {
    id: 'ai-service-autostart',
    category: 'ai',
    label: 'Yapay Zeka Hizmeti Otomatik Başlatma',
    description: 'Yapay zeka hizmetlerinin arka planda otomatik başlamasını engelleyin',
    requiresAdmin: true,
    check: async () => !(await isServiceEnabled('AiHost')),
    apply: () => disableService('AiHost'),
    revert: () => enableService('AiHost'),
    applicable: () => serviceExists('AiHost')
  },
  {
    id: 'edge-ai-features',
    category: 'ai',
    label: 'Edge Compose AI',
    description: 'Edge yapay zeka metin oluşturma ve yeniden yazma özelliklerini devre dışı bırakın',
    requiresAdmin: true,
    check: async () => {
      const val = await regQueryDword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge', 'ComposeInlineEnabled')
      return val === 0
    },
    apply: () => regSetDword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge', 'ComposeInlineEnabled', 0),
    revert: () => regDeleteValue('HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge', 'ComposeInlineEnabled')
  },
  {
    id: 'paint-ai',
    category: 'ai',
    label: 'Paint Yapay Zeka Özellikleri',
    description: 'Microsoft Paint\'teki yapay zeka görüntü oluşturma özelliklerini devre dışı bırakın',
    requiresAdmin: true,
    check: async () => {
      const val = await regQueryDword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Paint', 'DisableCocreator')
      return val === 1
    },
    apply: () => regSetDword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Paint', 'DisableCocreator', 1),
    revert: () => regDeleteValue('HKLM\\SOFTWARE\\Policies\\Microsoft\\Paint', 'DisableCocreator')
  },
  {
    id: 'notepad-ai',
    category: 'ai',
    label: 'Not Defteri Yapay Zeka Özellikleri',
    description: 'Microsoft Not Defteri\'ndeki yapay zeka metin yeniden yazma özelliklerini devre dışı bırakın',
    requiresAdmin: true,
    check: async () => {
      const val = await regQueryDword('HKLM\\SOFTWARE\\Policies\\Microsoft\\WindowsNotepad', 'DisableAIFeatures')
      return val === 1
    },
    apply: () => regSetDword('HKLM\\SOFTWARE\\Policies\\Microsoft\\WindowsNotepad', 'DisableAIFeatures', 1),
    revert: () => regDeleteValue('HKLM\\SOFTWARE\\Policies\\Microsoft\\WindowsNotepad', 'DisableAIFeatures')
  },

  // ─── TELEMETRY SERVICES ───
  {
    id: 'service-diagtrack',
    category: 'services',
    label: 'DiagTrack Hizmeti',
    description: 'Bağlı Kullanıcı Deneyimleri ve Telemetri hizmetini devre dışı bırakın',
    requiresAdmin: true,
    check: async () => !(await isServiceEnabled('DiagTrack')),
    apply: () => disableService('DiagTrack'),
    revert: () => enableService('DiagTrack'),
    applicable: () => serviceExists('DiagTrack')
  },
  {
    id: 'service-dmwappush',
    category: 'services',
    label: 'WAP Push Hizmeti',
    description: 'Telemetri için kullanılan WAP Push ileti yönlendirme hizmetini devre dışı bırakın',
    requiresAdmin: true,
    check: async () => !(await isServiceEnabled('dmwappushservice')),
    apply: () => disableService('dmwappushservice'),
    revert: () => enableService('dmwappushservice'),
    applicable: () => serviceExists('dmwappushservice')
  },
  {
    id: 'service-delivery-optimization',
    category: 'services',
    label: 'Teslimat Optimizasyonu',
    description: 'Windows Update P2P paylaşımını devre dışı bırakın — bilgisayarınızın güncelleme verilerini diğer cihazlara yüklemesini durdurur',
    requiresAdmin: true,
    check: async () => {
      const val = await regQueryDword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\DeliveryOptimization', 'DODownloadMode')
      return val === 0
    },
    apply: () => regSetDword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\DeliveryOptimization', 'DODownloadMode', 0),
    revert: () => regDeleteValue('HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\DeliveryOptimization', 'DODownloadMode')
  },
  {
    id: 'service-mapsbroker',
    category: 'services',
    label: 'Haritalar Aracısı',
    description: 'İndirilen Haritalar Yöneticisini devre dışı bırakın — gereksiz arka plan hizmeti',
    requiresAdmin: true,
    check: async () => !(await isServiceEnabled('MapsBroker')),
    apply: () => disableService('MapsBroker'),
    revert: () => enableService('MapsBroker'),
    applicable: () => serviceExists('MapsBroker')
  },

  // ─── TELEMETRY TASKS ───
  {
    id: 'task-compatibility-appraiser',
    category: 'tasks',
    label: 'Uyumluluk Değerlendiricisi',
    description: 'Uyumluluk verileri için Microsoft telemetri toplayıcısını devre dışı bırakın',
    requiresAdmin: true,
    check: async () => !(await isTaskActive('\\Microsoft\\Windows\\Application Experience\\Microsoft Compatibility Appraiser')),
    apply: () => disableTask('\\Microsoft\\Windows\\Application Experience\\Microsoft Compatibility Appraiser'),
    revert: () => enableTask('\\Microsoft\\Windows\\Application Experience\\Microsoft Compatibility Appraiser'),
    applicable: () => taskExists('\\Microsoft\\Windows\\Application Experience\\Microsoft Compatibility Appraiser')
  },
  {
    id: 'task-program-data-updater',
    category: 'tasks',
    label: 'Program Verisi Güncelleyicisi',
    description: 'Arka plan program telemetrisi yükleme görevini devre dışı bırakın',
    requiresAdmin: true,
    check: async () => !(await isTaskActive('\\Microsoft\\Windows\\Application Experience\\ProgramDataUpdater')),
    apply: () => disableTask('\\Microsoft\\Windows\\Application Experience\\ProgramDataUpdater'),
    revert: () => enableTask('\\Microsoft\\Windows\\Application Experience\\ProgramDataUpdater'),
    applicable: () => taskExists('\\Microsoft\\Windows\\Application Experience\\ProgramDataUpdater')
  },
  {
    id: 'task-autochk-proxy',
    category: 'tasks',
    label: 'Autochk Proxy',
    description: 'Autochk proxy üzerinden telemetri verisi toplamayı devre dışı bırakın',
    requiresAdmin: true,
    check: async () => !(await isTaskActive('\\Microsoft\\Windows\\Autochk\\Proxy')),
    apply: () => disableTask('\\Microsoft\\Windows\\Autochk\\Proxy'),
    revert: () => enableTask('\\Microsoft\\Windows\\Autochk\\Proxy'),
    applicable: () => taskExists('\\Microsoft\\Windows\\Autochk\\Proxy')
  },
  {
    id: 'task-ceip-consolidator',
    category: 'tasks',
    label: 'CEIP Birleştirici',
    description: 'Müşteri Deneyimini İyileştirme Programı veri yüklemesini devre dışı bırakın',
    requiresAdmin: true,
    check: async () => !(await isTaskActive('\\Microsoft\\Windows\\Customer Experience Improvement Program\\Consolidator')),
    apply: () => disableTask('\\Microsoft\\Windows\\Customer Experience Improvement Program\\Consolidator'),
    revert: () => enableTask('\\Microsoft\\Windows\\Customer Experience Improvement Program\\Consolidator'),
    applicable: () => taskExists('\\Microsoft\\Windows\\Customer Experience Improvement Program\\Consolidator')
  },
  {
    id: 'task-usb-ceip',
    category: 'tasks',
    label: 'USB CEIP',
    description: 'USB cihaz kullanımı telemetrisi toplamayı devre dışı bırakın',
    requiresAdmin: true,
    check: async () => !(await isTaskActive('\\Microsoft\\Windows\\Customer Experience Improvement Program\\UsbCeip')),
    apply: () => disableTask('\\Microsoft\\Windows\\Customer Experience Improvement Program\\UsbCeip'),
    revert: () => enableTask('\\Microsoft\\Windows\\Customer Experience Improvement Program\\UsbCeip'),
    applicable: () => taskExists('\\Microsoft\\Windows\\Customer Experience Improvement Program\\UsbCeip')
  },
  {
    id: 'task-disk-diagnostic',
    category: 'tasks',
    label: 'Disk Tanılama Toplayıcısı',
    description: 'Disk tanılama verisi toplamayı ve yüklemeyi devre dışı bırakın',
    requiresAdmin: true,
    check: async () => !(await isTaskActive('\\Microsoft\\Windows\\DiskDiagnostic\\Microsoft-Windows-DiskDiagnosticDataCollector')),
    apply: () => disableTask('\\Microsoft\\Windows\\DiskDiagnostic\\Microsoft-Windows-DiskDiagnosticDataCollector'),
    revert: () => enableTask('\\Microsoft\\Windows\\DiskDiagnostic\\Microsoft-Windows-DiskDiagnosticDataCollector'),
    applicable: () => taskExists('\\Microsoft\\Windows\\DiskDiagnostic\\Microsoft-Windows-DiskDiagnosticDataCollector')
  },
  {
    id: 'task-feedback-dm',
    category: 'tasks',
    label: 'Geri Bildirim DM İstemcisi',
    description: 'Geri bildirim cihaz yönetimi telemetri görevini devre dışı bırakın',
    requiresAdmin: true,
    check: async () => !(await isTaskActive('\\Microsoft\\Windows\\Feedback\\Siuf\\DmClient')),
    apply: () => disableTask('\\Microsoft\\Windows\\Feedback\\Siuf\\DmClient'),
    revert: () => enableTask('\\Microsoft\\Windows\\Feedback\\Siuf\\DmClient'),
    applicable: () => taskExists('\\Microsoft\\Windows\\Feedback\\Siuf\\DmClient')
  },
  {
    id: 'task-maps-update',
    category: 'tasks',
    label: 'Harita Güncelleme Görevi',
    description: 'Arka planda otomatik harita verisi indirmelerini devre dışı bırakın',
    requiresAdmin: true,
    check: async () => !(await isTaskActive('\\Microsoft\\Windows\\Maps\\MapsUpdateTask')),
    apply: () => disableTask('\\Microsoft\\Windows\\Maps\\MapsUpdateTask'),
    revert: () => enableTask('\\Microsoft\\Windows\\Maps\\MapsUpdateTask'),
    applicable: () => taskExists('\\Microsoft\\Windows\\Maps\\MapsUpdateTask')
  },
  {
    id: 'task-maps-toast',
    category: 'tasks',
    label: 'Harita Bildirim Görevi',
    description: 'Haritalar bildirim görevini devre dışı bırakın',
    requiresAdmin: true,
    check: async () => !(await isTaskActive('\\Microsoft\\Windows\\Maps\\MapsToastTask')),
    apply: () => disableTask('\\Microsoft\\Windows\\Maps\\MapsToastTask'),
    revert: () => enableTask('\\Microsoft\\Windows\\Maps\\MapsToastTask'),
    applicable: () => taskExists('\\Microsoft\\Windows\\Maps\\MapsToastTask')
  },

  // ─── BROWSER TELEMETRY ───

  // Edge
  {
    id: 'edge-metrics',
    category: 'browser',
    label: 'Edge Ölçüm Raporlama',
    description: 'Edge\'in kullanım ve kilitlenme ölçümlerini Microsoft\'a göndermesini durdurun',
    requiresAdmin: true,
    check: async () => {
      const val = await regQueryDword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge', 'MetricsReportingEnabled')
      return val === 0
    },
    apply: () => regSetDword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge', 'MetricsReportingEnabled', 0),
    revert: () => regDeleteValue('HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge', 'MetricsReportingEnabled')
  },
  {
    id: 'edge-site-info',
    category: 'browser',
    label: 'Edge Site Bilgisi Toplama',
    description: 'Edge\'in hizmetleri iyileştirmek için site URL\'lerini Microsoft\'a göndermesini durdurun',
    requiresAdmin: true,
    check: async () => {
      const val = await regQueryDword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge', 'SendSiteInfoToImproveServices')
      return val === 0
    },
    apply: () => regSetDword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge', 'SendSiteInfoToImproveServices', 0),
    revert: () => regDeleteValue('HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge', 'SendSiteInfoToImproveServices')
  },
  {
    id: 'edge-personalization',
    category: 'browser',
    label: 'Edge Kişiselleştirme Raporlama',
    description: 'Edge\'in reklam kişiselleştirme için gezinme geçmişini göndermesini durdurun',
    requiresAdmin: true,
    check: async () => {
      const val = await regQueryDword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge', 'PersonalizationReportingEnabled')
      return val === 0
    },
    apply: () => regSetDword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge', 'PersonalizationReportingEnabled', 0),
    revert: () => regDeleteValue('HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge', 'PersonalizationReportingEnabled')
  },
  {
    id: 'edge-copilot-cdp',
    category: 'browser',
    label: 'Edge Copilot Sayfa Erişimi (CDP)',
    description: 'Copilot\'un Chrome DevTools Protocol üzerinden sayfa içeriğinizi okumasını engelleyin',
    requiresAdmin: true,
    check: async () => {
      const val = await regQueryDword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge', 'CopilotCDPPageContext')
      return val === 0
    },
    apply: () => regSetDword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge', 'CopilotCDPPageContext', 0),
    revert: () => regDeleteValue('HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge', 'CopilotCDPPageContext')
  },
  {
    id: 'edge-copilot-page',
    category: 'browser',
    label: 'Edge Copilot Sayfa Bağlamı',
    description: 'Copilot\'un içerik analizi için sayfa bağlamına erişmesini engelleyin',
    requiresAdmin: true,
    check: async () => {
      const val = await regQueryDword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge', 'CopilotPageContext')
      return val === 0
    },
    apply: () => regSetDword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge', 'CopilotPageContext', 0),
    revert: () => regDeleteValue('HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge', 'CopilotPageContext')
  },
  {
    id: 'edge-discover',
    category: 'browser',
    label: 'Edge Discover Sayfa Tarama',
    description: 'Discover özelliğinin sayfa içeriğini taramasını durdurun',
    requiresAdmin: true,
    check: async () => {
      const val = await regQueryDword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge', 'DiscoverPageContextEnabled')
      return val === 0
    },
    apply: () => regSetDword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge', 'DiscoverPageContextEnabled', 0),
    revert: () => regDeleteValue('HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge', 'DiscoverPageContextEnabled')
  },
  {
    id: 'edge-sidebar',
    category: 'browser',
    label: 'Edge Kenar Çubuğu',
    description: 'Edge kenar çubuğunu ve arka plan veri toplamayı devre dışı bırakın',
    requiresAdmin: true,
    check: async () => {
      const val = await regQueryDword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge', 'HubsSidebarEnabled')
      return val === 0
    },
    apply: () => regSetDword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge', 'HubsSidebarEnabled', 0),
    revert: () => regDeleteValue('HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge', 'HubsSidebarEnabled')
  },
  {
    id: 'edge-shopping',
    category: 'browser',
    label: 'Edge Alışveriş Asistanı',
    description: 'Edge\'deki alışveriş fiyat karşılaştırma izleyicisini devre dışı bırakın',
    requiresAdmin: true,
    check: async () => {
      const val = await regQueryDword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge', 'EdgeShoppingAssistantEnabled')
      return val === 0
    },
    apply: () => regSetDword('HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge', 'EdgeShoppingAssistantEnabled', 0),
    revert: () => regDeleteValue('HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge', 'EdgeShoppingAssistantEnabled')
  },

  // Chrome
  {
    id: 'chrome-metrics',
    category: 'browser',
    label: 'Chrome Ölçüm Raporlama',
    description: 'Chrome\'un kullanım ve kilitlenme ölçümlerini Google\'a göndermesini durdurun',
    requiresAdmin: true,
    check: async () => {
      if (!await isBrowserInstalled('HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe')) return true
      const val = await regQueryDword('HKLM\\SOFTWARE\\Policies\\Google\\Chrome', 'MetricsReportingEnabled')
      return val === 0
    },
    apply: () => regSetDword('HKLM\\SOFTWARE\\Policies\\Google\\Chrome', 'MetricsReportingEnabled', 0),
    revert: () => regDeleteValue('HKLM\\SOFTWARE\\Policies\\Google\\Chrome', 'MetricsReportingEnabled'),
    applicable: () => isBrowserInstalled('HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe')
  },
  {
    id: 'chrome-feedback',
    category: 'browser',
    label: 'Chrome Kullanıcı Geri Bildirimi',
    description: 'Chrome\'un kullanıcı geri bildirim verilerini toplayıp göndermesini engelleyin',
    requiresAdmin: true,
    check: async () => {
      if (!await isBrowserInstalled('HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe')) return true
      const val = await regQueryDword('HKLM\\SOFTWARE\\Policies\\Google\\Chrome', 'UserFeedbackAllowed')
      return val === 0
    },
    apply: () => regSetDword('HKLM\\SOFTWARE\\Policies\\Google\\Chrome', 'UserFeedbackAllowed', 0),
    revert: () => regDeleteValue('HKLM\\SOFTWARE\\Policies\\Google\\Chrome', 'UserFeedbackAllowed'),
    applicable: () => isBrowserInstalled('HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe')
  },
  {
    id: 'chrome-extended-reporting',
    category: 'browser',
    label: 'Chrome Gelişmiş Güvenli Tarama',
    description: 'Chrome\'un genişletilmiş URL ve indirme raporlarını Google\'a göndermesini durdurun',
    requiresAdmin: true,
    check: async () => {
      if (!await isBrowserInstalled('HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe')) return true
      const val = await regQueryDword('HKLM\\SOFTWARE\\Policies\\Google\\Chrome', 'SafeBrowsingExtendedReportingEnabled')
      return val === 0
    },
    apply: () => regSetDword('HKLM\\SOFTWARE\\Policies\\Google\\Chrome', 'SafeBrowsingExtendedReportingEnabled', 0),
    revert: () => regDeleteValue('HKLM\\SOFTWARE\\Policies\\Google\\Chrome', 'SafeBrowsingExtendedReportingEnabled'),
    applicable: () => isBrowserInstalled('HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe')
  },

  // Firefox
  {
    id: 'firefox-telemetry',
    category: 'browser',
    label: 'Firefox Telemetrisi',
    description: 'Firefox telemetri verisi toplamayı ve Mozilla\'ya yüklemeyi devre dışı bırakın',
    requiresAdmin: true,
    check: async () => {
      if (!await isBrowserInstalled('HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\firefox.exe')) return true
      const val = await regQueryDword('HKLM\\SOFTWARE\\Policies\\Mozilla\\Firefox', 'DisableTelemetry')
      return val === 1
    },
    apply: () => regSetDword('HKLM\\SOFTWARE\\Policies\\Mozilla\\Firefox', 'DisableTelemetry', 1),
    revert: () => regDeleteValue('HKLM\\SOFTWARE\\Policies\\Mozilla\\Firefox', 'DisableTelemetry'),
    applicable: () => isBrowserInstalled('HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\firefox.exe')
  },
  {
    id: 'firefox-default-agent',
    category: 'browser',
    label: 'Firefox Varsayılan Tarayıcı Aracısı',
    description: 'Tarayıcı kullanım verilerini Mozilla\'ya bildiren arka plan aracısını devre dışı bırakın',
    requiresAdmin: true,
    check: async () => {
      if (!await isBrowserInstalled('HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\firefox.exe')) return true
      const val = await regQueryDword('HKLM\\SOFTWARE\\Policies\\Mozilla\\Firefox', 'DisableDefaultBrowserAgent')
      return val === 1
    },
    apply: () => regSetDword('HKLM\\SOFTWARE\\Policies\\Mozilla\\Firefox', 'DisableDefaultBrowserAgent', 1),
    revert: () => regDeleteValue('HKLM\\SOFTWARE\\Policies\\Mozilla\\Firefox', 'DisableDefaultBrowserAgent'),
    applicable: () => isBrowserInstalled('HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\firefox.exe')
  }
]

// ─── Exported core logic ─────────────────────────────────────

export { SETTINGS as PRIVACY_SETTINGS }

function getSettingsForPlatform(): SettingDef[] {
  if (process.platform === 'win32') return SETTINGS
  return getPlatform().privacy.getSettings()
}

export async function scanPrivacy(
  onProgress?: (data: { current: number; total: number; currentLabel: string; category: string }) => void
): Promise<PrivacyShieldState> {
    const settingDefs = getSettingsForPlatform()
    const settings: PrivacySetting[] = []
    const total = settingDefs.length

    for (let i = 0; i < settingDefs.length; i++) {
      const def = settingDefs[i]

      onProgress?.({
        current: i + 1,
        total,
        currentLabel: def.label,
        category: def.category
      })

      // Each check gets a hard 10s deadline so one hanging check can't block everything
      const enabled = await withTimeout(
        def.check().catch(() => false),
        10000,
        false
      )

      // A setting is only reversible if it has a revert function AND the underlying
      // resource actually exists (e.g. browser installed, task present, service present).
      // Settings that report enabled=true because the resource is absent are vacuously
      // true and should not offer a revert toggle.
      const hasRevert = typeof def.revert === 'function'
      const isApplicable = def.applicable
        ? await withTimeout(def.applicable().catch(() => true), 10000, true)
        : true
      const reversible = hasRevert && isApplicable

      settings.push({
        id: def.id,
        category: def.category,
        label: def.label,
        description: def.description,
        enabled,
        reversible,
        requiresAdmin: def.requiresAdmin,
        ...(def.dependsOn ? { dependsOn: def.dependsOn } : {})
      })
    }

    const protectedCount = settings.filter(s => s.enabled).length
    const score = total > 0 ? Math.round((protectedCount / total) * 100) : 0

    return { settings, score, total, protected: protectedCount }
}

export async function applyPrivacySettings(ids: string[]): Promise<PrivacyApplyResult> {
    const settingDefs = getSettingsForPlatform()
    let succeeded = 0
    let failed = 0
    const errors: PrivacyApplyResult['errors'] = []

    for (const id of ids) {
      const def = settingDefs.find(s => s.id === id)
      if (!def) continue

      try {
        await def.apply()
        succeeded++
      } catch (err) {
        failed++
        errors.push({
          id: def.id,
          label: def.label,
          reason: err instanceof Error ? err.message : 'Unknown error'
        })
      }
    }

    return { succeeded, failed, errors }
}

export async function revertPrivacySettings(ids: string[]): Promise<PrivacyApplyResult> {
    const settingDefs = getSettingsForPlatform()
    let succeeded = 0
    let failed = 0
    const errors: PrivacyApplyResult['errors'] = []

    for (const id of ids) {
      const def = settingDefs.find(s => s.id === id)
      if (!def || !def.revert) {
        failed++
        errors.push({ id, label: id, reason: 'Revert not supported for this setting' })
        continue
      }

      try {
        await def.revert()
        succeeded++
      } catch (err) {
        failed++
        errors.push({
          id: def.id,
          label: def.label,
          reason: err instanceof Error ? err.message : 'Unknown error'
        })
      }
    }

    return { succeeded, failed, errors }
}

// ─── IPC handlers ────────────────────────────────────────────

export function registerPrivacyShieldIpc(getWindow: WindowGetter): void {
  ipcMain.handle(IPC.PRIVACY_SCAN, () => scanPrivacy((data) => {
    sendProgress(getWindow(), data)
  }))

  ipcMain.handle(IPC.PRIVACY_APPLY, async (_event, ids: string[]) => {
    const valid = validateStringArray(ids, 1_000)
    if (!valid) return { succeeded: 0, failed: 0, errors: [] }
    return applyPrivacySettings(valid)
  })

  ipcMain.handle(IPC.PRIVACY_REVERT, async (_event, ids: string[]) => {
    const valid = validateStringArray(ids, 1_000)
    if (!valid) return { succeeded: 0, failed: 0, errors: [] }
    return revertPrivacySettings(valid)
  })
}
