import { useEffect, useState, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  HardDrive,
  Sparkles,
  Search,
  Database,
  Zap,
  Shield,
  CheckCircle2,
  Loader2,
  Cpu,
  Check,
  Download,
  Server,
  Gamepad2,
  MemoryStick,
  AlertTriangle,
  History,
  Eye
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { cn, formatBytes, formatDate, formatNumber } from '@/lib/utils'
import { cleanInBatches } from '@/lib/cleaner-batches'
import { useStatsStore } from '@/stores/stats-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useHistoryStore } from '@/stores/history-store'
import { useScanStore } from '@/stores/scan-store'
import { useUpdaterStore } from '@/stores/updater-store'
import { useServiceStore } from '@/stores/service-store'
import { useStartupStore } from '@/stores/startup-store'
import { useGameModeStore } from '@/stores/game-mode-store'
import { useMalwareStore } from '@/stores/malware-store'
import type { DriveInfo, ScanResult, CleanResult, PerfQuickStats } from '@shared/types'
import { CleanerType } from '@shared/enums'
import { usePlatform } from '@/hooks/usePlatform'

type OneClickPhase = 'idle' | 'scanning' | 'cleaning' | 'done'

interface OneClickResult {
  spaceRecovered: number
  filesCleaned: number
  registryFixed: number
  driversRemoved: number
  threatsFound: number
  threatsQuarantined: number
  privacyScore: number
  privacyIssues: number
  startupHighImpact: number
  updatesAvailable: number
}

const CLEANER_SCAN_FNS: { type: CleanerType; scan: () => Promise<ScanResult[]>; clean: (ids: string[]) => Promise<CleanResult> }[] = [
  { type: CleanerType.System, scan: () => window.ertcleaner.systemScan(), clean: (ids) => window.ertcleaner.systemClean(ids) },
  { type: CleanerType.Browser, scan: () => window.ertcleaner.browserScan(), clean: (ids) => window.ertcleaner.browserClean(ids) },
  { type: CleanerType.App, scan: () => window.ertcleaner.appScan(), clean: (ids) => window.ertcleaner.appClean(ids) },
  { type: CleanerType.Gaming, scan: () => window.ertcleaner.gamingScan(), clean: (ids) => window.ertcleaner.gamingClean(ids) },
  { type: CleanerType.RecycleBin, scan: () => window.ertcleaner.recycleBinScan(), clean: () => window.ertcleaner.recycleBinClean() },
  { type: CleanerType.Environment, scan: () => window.ertcleaner.environmentScan(), clean: (ids) => window.ertcleaner.environmentClean(ids) },
  { type: CleanerType.Database, scan: () => window.ertcleaner.databaseScan(), clean: (ids) => window.ertcleaner.databaseClean(ids) },
]

export function DashboardPage() {
  const { t } = useTranslation('dashboard')
  const { features } = usePlatform()
  const stats = useStatsStore((s) => s.stats)
  const recomputeStats = useStatsStore((s) => s.recompute)
  const historyStore = useHistoryStore()
  const scanStore = useScanStore()
  const updaterHasChecked = useUpdaterStore((s) => s.hasChecked)
  const updaterApps = useUpdaterStore((s) => s.apps)
  const updaterRemindersEnabled = useSettingsStore((s) => s.settings.softwareUpdaterNotifications ?? true)
  const serviceHasScanned = useServiceStore((s) => s.hasScanned)
  const startupItems = useStartupStore((s) => s.items)
  const startupHasLoaded = useStartupStore((s) => s.hasLoaded)
  const startupLoading = useStartupStore((s) => s.loading)
  const lastMalwareScan = useMalwareStore((s) => s.lastCompletedScan)
  const knownActiveThreats = useMalwareStore((s) => s.knownActiveThreats)
  const gameModeActive = useGameModeStore((s) => s.active)
  const gameModeActivatedAt = useGameModeStore((s) => s.activatedAt)
  const cleanStartRef = useRef<number>(0)
  const startupLoadAttemptedRef = useRef(false)
  const navigate = useNavigate()
  const [drives, setDrives] = useState<DriveInfo[]>([])
  const [driveStatus, setDriveStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading')
  const [phase, setPhase] = useState<OneClickPhase>('idle')
  const [phaseLabel, setPhaseLabel] = useState('')
  const [result, setResult] = useState<OneClickResult | null>(null)
  const [showQuickConfirm, setShowQuickConfirm] = useState(false)
  const [showFullConfirm, setShowFullConfirm] = useState(false)
  const [stepProgress, setStepProgress] = useState({ current: 0, total: 0 })

  // ── Lightweight system metrics (no heavy process polling) ──
  const [perf, setPerf] = useState<PerfQuickStats | null>(null)

  useEffect(() => {
    let cancelled = false
    // Initial sample seeds the CPU diff; first result will read 0%
    window.ertcleaner?.perfQuickStats?.().catch(() => {})
    const poll = async () => {
      try {
        const data = await window.ertcleaner?.perfQuickStats?.()
        if (!cancelled && data) setPerf(data)
      } catch { /* best effort */ }
    }
    // Poll every 3s — uses only os.cpus()/os.freemem(), near-zero cost
    const iv = setInterval(poll, 3000)
    // First real read after 1s (gives CPU diff time to accumulate)
    const initial = setTimeout(poll, 1000)
    return () => { cancelled = true; clearInterval(iv); clearTimeout(initial) }
  }, [])

  // ── Game Mode elapsed timer ────────────────────────────────
  const [gmElapsed, setGmElapsed] = useState(0)
  useEffect(() => {
    if (!gameModeActive || !gameModeActivatedAt) { setGmElapsed(0); return }
    const start = new Date(gameModeActivatedAt).getTime()
    const tick = () => setGmElapsed(Date.now() - start)
    tick()
    const iv = setInterval(tick, 1000)
    return () => clearInterval(iv)
  }, [gameModeActive, gameModeActivatedAt])

  const refreshDrives = useCallback(() => {
    setDriveStatus('loading')
    window.ertcleaner?.diskDrives?.()
      .then((nextDrives) => {
        setDrives(nextDrives)
        setDriveStatus(nextDrives.length > 0 ? 'ready' : 'unavailable')
      })
      .catch(() => {
        setDrives([])
        setDriveStatus('unavailable')
      })
  }, [])

  useEffect(() => { refreshDrives() }, [refreshDrives])

  // The dashboard owns its status claims, so it loads startup state instead
  // of assuming an empty store means there are no high-impact apps.
  useEffect(() => {
    if (startupHasLoaded || startupLoading || startupLoadAttemptedRef.current) return
    startupLoadAttemptedRef.current = true
    const startupStore = useStartupStore.getState()
    startupStore.setLoading(true)
    window.ertcleaner.startupList()
      .then((items) => startupStore.setItems(items))
      .catch(() => startupStore.setError(t('toastStartupCheckFailed')))
      .finally(() => startupStore.setLoading(false))
  }, [startupHasLoaded, startupLoading, t])

  // ── Health score ───────────────────────────────────────────

  const toolCoverage = (() => {
    const entries = historyStore.entries
    const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000
    const recentEntries = entries.filter((e) => new Date(e.timestamp).getTime() > twoWeeksAgo)
    const recentTypes = new Set(recentEntries.map((e) => e.type))
    const allTypes = new Set(entries.map((e) => e.type))

    const historyTools = [
      { key: 'cleaner' as const, label: t('toolLabelCleaner'), icon: Search, color: '#2f7de1' },
      ...(features.registry ? [{ key: 'registry' as const, label: t('toolLabelRegistry'), icon: Database, color: '#3b82f6' }] : []),
      ...(features.drivers ? [{ key: 'drivers' as const, label: t('toolLabelDrivers'), icon: Cpu, color: '#a855f7' }] : [])
    ]

    const historyResults = historyTools.map((t) => ({
      ...t,
      usedRecently: recentTypes.has(t.key),
      usedEver: allTypes.has(t.key)
    }))

    const sessionTools = [
      ...(updaterRemindersEnabled ? [{ key: 'updater', label: t('toolLabelUpdater'), icon: Download, color: '#06b6d4', active: updaterHasChecked }] : []),
      { key: 'services', label: t('toolLabelServices'), icon: Server, color: '#ec4899', active: serviceHasScanned },
      { key: 'startup', label: t('toolLabelStartup'), icon: Zap, color: '#22c55e', active: startupHasLoaded }
    ]

    const sessionResults = sessionTools.map((t) => ({
      key: t.key,
      label: t.label,
      icon: t.icon,
      color: t.color,
      usedRecently: t.active,
      usedEver: t.active
    }))

    return [...historyResults, ...sessionResults]
  })()

  const healthScore = (() => {
    const totalTools = toolCoverage.length
    const doneTools = toolCoverage.filter((t) => t.usedRecently).length
    let score = Math.round((doneTools / totalTools) * 60)

    if (drives.length > 0) {
      const worstUsage = Math.max(...drives.map((d) => d.usedSpace / d.totalSize))
      if (worstUsage > 0.7) {
        score -= Math.min(20, Math.round((worstUsage - 0.7) / 0.3 * 20))
      }
    }

    if (lastMalwareScan) {
      const daysSinceScan = (Date.now() - new Date(lastMalwareScan.completedAt).getTime()) / (1000 * 60 * 60 * 24)
      score -= Math.min(20, Math.round(daysSinceScan * (20 / 7)))
    } else {
      score -= 10
    }

    if (lastMalwareScan) score += 40
    const activeThreatCount = (lastMalwareScan?.unresolvedThreats ?? 0) + knownActiveThreats
    if (activeThreatCount > 0) score -= Math.min(30, activeThreatCount * 10)
    return Math.max(0, Math.min(100, score))
  })()

  // ── One-click clean callbacks (unchanged logic) ────────────

  const protectRecycleBin = useSettingsStore((s) => s.settings.cleaner.protectRecycleBin)

  const runCleaners = useCallback(async (): Promise<{ space: number; files: number }> => {
    const excluded = scanStore.excludedSubcategories
    let totalSpace = 0
    let totalFiles = 0

    for (const { type, scan, clean } of CLEANER_SCAN_FNS) {
      if (type === CleanerType.RecycleBin && protectRecycleBin) continue
      try {
        setPhaseLabel(t('phaseLabelScanningType', { type }))
        const results = await scan()
        const selectedIds = results
          .filter((r) => !excluded.has(r.subcategory))
          .flatMap((r) => r.items.map((i) => i.id))
        if (selectedIds.length > 0) {
          setPhaseLabel(t('phaseLabelCleaningType', { type }))
          const cleaned = await cleanInBatches(selectedIds, clean)
          const res = cleaned.result
          totalSpace += res.totalCleaned || 0
          totalFiles += res.filesDeleted || 0
          if (cleaned.error) toast.error(t('toastFailedToCleanType', { type }))
        }
      } catch {
        toast.error(t('toastFailedToCleanType', { type }))
      }
    }
    return { space: totalSpace, files: totalFiles }
  }, [scanStore.excludedSubcategories, protectRecycleBin, t])

  const runRegistry = useCallback(async (): Promise<number> => {
    try {
      setPhaseLabel(t('phaseLabelScanningRegistry'))
      const entries = await window.ertcleaner.registryScan()
      if (!Array.isArray(entries)) return 0
      const selectedIds = entries.filter((e) => e?.selected).map((e) => e.id)
      if (selectedIds.length === 0) return 0
      setPhaseLabel(t('phaseLabelFixingRegistry'))
      const res = await window.ertcleaner.registryFix(selectedIds)
      return res?.fixed ?? 0
    } catch {
      toast.error(t('toastRegistryScanFailed'))
      return 0
    }
  }, [t])

  const runMalwareScan = useCallback(async (): Promise<{ found: number; quarantined: number }> => {
    const malwareStore = useMalwareStore.getState()
    malwareStore.setStatus('scanning')
    malwareStore.setThreats([])
    malwareStore.setActionResult(null)
    try {
      setPhaseLabel(t('phaseLabelScanningMalware'))
      const result = await window.ertcleaner.malwareScan()
      malwareStore.setScanResult(result)
      malwareStore.setThreats(result.threats)
      malwareStore.setActionResult(null)
      malwareStore.setStatus('complete')
      if (result.threats.length === 0) return { found: 0, quarantined: 0 }
      setPhaseLabel(t('phaseLabelQuarantiningThreats'))
      const paths = result.threats.map((t) => t.path)
      const meta = result.threats.map((t) => ({
        path: t.path,
        detectionName: t.detectionName,
        severity: t.severity,
        source: t.source,
        details: t.details
      }))
      try {
        const actionResult = await window.ertcleaner.malwareQuarantine(paths, meta)
        const failedPaths = new Set(actionResult.errors.map((error) => error.path))
        const knownUnresolved = result.threats.filter((threat) => failedPaths.has(threat.path))
        malwareStore.setActionResult(actionResult)
        malwareStore.setThreats(knownUnresolved)
        malwareStore.setUnresolvedThreatCount(Math.max(actionResult.failed, result.threats.length - actionResult.succeeded))
        return { found: result.threats.length, quarantined: actionResult.succeeded }
      } catch {
        // The scan still completed successfully. Preserve its detections so the
        // result, history, and health score do not report active threats as clean.
        malwareStore.setUnresolvedThreatCount(result.threats.length)
        toast.error(t('malware:toastActionFailed', { action: 'quarantine' }))
        return { found: result.threats.length, quarantined: 0 }
      }
    } catch {
      malwareStore.setStatus('idle')
      toast.error(t('toastMalwareScanFailed'))
      return { found: 0, quarantined: 0 }
    }
  }, [t])

  const runPrivacyCheck = useCallback(async (): Promise<{ score: number; issues: number }> => {
    try {
      setPhaseLabel(t('phaseLabelCheckingPrivacy'))
      const state = await window.ertcleaner.privacyScan()
      return { score: state.score, issues: state.total - state.protected }
    } catch {
      toast.error(t('toastPrivacyCheckFailed'))
      return { score: 0, issues: 0 }
    }
  }, [t])

  const runStartupCheck = useCallback(async (): Promise<number> => {
    try {
      setPhaseLabel(t('phaseLabelCheckingStartup'))
      const items = await window.ertcleaner.startupList()
      useStartupStore.getState().setItems(items)
      return items.filter((i) => i.enabled && i.impact === 'high').length
    } catch {
      toast.error(t('toastStartupCheckFailed'))
      return 0
    }
  }, [t])

  const runSoftwareUpdateCheck = useCallback(async (): Promise<number> => {
    try {
      setPhaseLabel(t('phaseLabelCheckingSoftwareUpdates'))
      const result = await window.ertcleaner.softwareUpdateCheck()
      const updaterStore = useUpdaterStore.getState()
      updaterStore.setApps(result.apps)
      updaterStore.setUpToDate(result.upToDate)
      updaterStore.setPackageManagerAvailable(result.packageManagerAvailable)
      updaterStore.setPackageManagerName(result.packageManagerName)
      updaterStore.setManagers(result.managers)
      updaterStore.setHasChecked(true)
      return result.apps.length
    } catch {
      toast.error(t('toastSoftwareUpdateCheckFailed'))
      return 0
    }
  }, [t])

  const runDrivers = useCallback(async (): Promise<{ removed: number; space: number }> => {
    try {
      setPhaseLabel(t('phaseLabelScanningDrivers'))
      const scanResult = await window.ertcleaner.driverScan()
      const stalePackages = scanResult.packages.filter((p) => !p.isCurrent && p.selected)
      if (stalePackages.length === 0) return { removed: 0, space: 0 }
      setPhaseLabel(t('phaseLabelRemovingStaleDrivers'))
      const cleanResult = await window.ertcleaner.driverClean(stalePackages.map((p) => p.publishedName))
      return { removed: cleanResult.removed, space: cleanResult.spaceRecovered }
    } catch {
      toast.error(t('toastDriverCleanupFailed'))
      return { removed: 0, space: 0 }
    }
  }, [t])

  const handleQuickClean = useCallback(async () => {
    if (phase !== 'idle' && phase !== 'done') return
    cleanStartRef.current = Date.now()
    setPhase('scanning')
    setResult(null)
    setStepProgress({ current: 0, total: 2 })

    setPhase('cleaning')
    setStepProgress({ current: 1, total: 2 })
    const { space, files } = await runCleaners()
    setStepProgress({ current: 2, total: 2 })
    const regFixed = features.registry ? await runRegistry() : 0

    const oneClickResult: OneClickResult = {
      spaceRecovered: space, filesCleaned: files, registryFixed: regFixed,
      driversRemoved: 0, threatsFound: 0, threatsQuarantined: 0,
      privacyScore: 0, privacyIssues: 0, startupHighImpact: 0, updatesAvailable: 0
    }

    const totalItems = files + regFixed
    if (totalItems > 0) {
      await historyStore.addEntry({
        id: Date.now().toString(), type: 'cleaner', timestamp: new Date().toISOString(),
        duration: Date.now() - cleanStartRef.current, totalItemsFound: totalItems,
        totalItemsCleaned: totalItems, totalItemsSkipped: 0, totalSpaceSaved: space,
        categories: [
          ...(files > 0 ? [{ name: 'Quick Clean', itemsFound: files, itemsCleaned: files, spaceSaved: space }] : []),
          ...(regFixed > 0 ? [{ name: 'Registry', itemsFound: regFixed, itemsCleaned: regFixed, spaceSaved: 0 }] : [])
        ],
        errorCount: 0
      })
      recomputeStats()
    }

    setResult(oneClickResult)
    setPhase('done')
    setPhaseLabel('')
    refreshDrives()
  }, [phase, runCleaners, runRegistry, historyStore, recomputeStats, features])

  const handleFullClean = useCallback(async () => {
    if (phase !== 'idle' && phase !== 'done') return
    cleanStartRef.current = Date.now()
    setPhase('scanning')
    setResult(null)
    const totalSteps = 5 + (features.registry ? 1 : 0) + (features.drivers ? 1 : 0)
    let step = 0
    setStepProgress({ current: step, total: totalSteps })

    setPhase('cleaning')
    setStepProgress({ current: ++step, total: totalSteps })
    const { space, files } = await runCleaners()
    let regFixed = 0
    if (features.registry) { setStepProgress({ current: ++step, total: totalSteps }); regFixed = await runRegistry() }
    let drivers = { removed: 0, space: 0 }
    if (features.drivers) { setStepProgress({ current: ++step, total: totalSteps }); drivers = await runDrivers() }

    setStepProgress({ current: ++step, total: totalSteps })
    const malware = await runMalwareScan()
    setStepProgress({ current: ++step, total: totalSteps })
    const privacy = await runPrivacyCheck()
    setStepProgress({ current: ++step, total: totalSteps })
    const startupHighImpact = await runStartupCheck()
    setStepProgress({ current: ++step, total: totalSteps })
    const updatesAvailable = useSettingsStore.getState().settings.softwareUpdaterNotifications === false
      ? 0
      : await runSoftwareUpdateCheck()

    const oneClickResult: OneClickResult = {
      spaceRecovered: space + drivers.space, filesCleaned: files, registryFixed: regFixed,
      driversRemoved: drivers.removed, threatsFound: malware.found,
      threatsQuarantined: malware.quarantined, privacyScore: privacy.score,
      privacyIssues: privacy.issues, startupHighImpact, updatesAvailable
    }

    const totalItems = files + regFixed + drivers.removed + malware.quarantined
    if (totalItems > 0 || malware.found > 0) {
      await historyStore.addEntry({
        id: Date.now().toString(), type: 'cleaner', timestamp: new Date().toISOString(),
        duration: Date.now() - cleanStartRef.current,
        totalItemsFound: totalItems + malware.found, totalItemsCleaned: totalItems,
        totalItemsSkipped: Math.max(0, malware.found - malware.quarantined), totalSpaceSaved: space + drivers.space,
        categories: [
          ...(files > 0 ? [{ name: 'Full Clean', itemsFound: files, itemsCleaned: files, spaceSaved: space }] : []),
          ...(regFixed > 0 ? [{ name: 'Registry', itemsFound: regFixed, itemsCleaned: regFixed, spaceSaved: 0 }] : []),
          ...(drivers.removed > 0 ? [{ name: 'Stale Drivers', itemsFound: drivers.removed, itemsCleaned: drivers.removed, spaceSaved: drivers.space }] : []),
          ...(malware.found > 0 ? [{ name: 'Malware', itemsFound: malware.found, itemsCleaned: malware.quarantined, spaceSaved: 0 }] : [])
        ],
        errorCount: Math.max(0, malware.found - malware.quarantined)
      })
      recomputeStats()
    }

    setResult(oneClickResult)
    setPhase('done')
    setPhaseLabel('')
    refreshDrives()
  }, [phase, runCleaners, runRegistry, runDrivers, runMalwareScan, runPrivacyCheck, runStartupCheck, runSoftwareUpdateCheck, historyStore, recomputeStats, features])

  const isRunning = phase === 'scanning' || phase === 'cleaning'

  // ── Helpers ────────────────────────────────────────────────

  const cpuPct = perf?.cpuPercent ?? 0
  const ramPct = perf?.memPercent ?? 0
  const diskPct = drives.length > 0
    ? Math.round((drives.reduce((s, d) => s + d.usedSpace, 0) / drives.reduce((s, d) => s + d.totalSize, 0)) * 100)
    : 0

  function formatGmElapsed(ms: number): string {
    const s = Math.floor(ms / 1000)
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = s % 60
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  }

  // ── Render ─────────────────────────────────────────────────

  const startupAttentionCount = startupItems.filter((item) => item.enabled && item.impact === 'high').length
  const pendingUpdateCount = updaterRemindersEnabled ? updaterApps.length : 0
  const unresolvedThreatCount = (lastMalwareScan?.unresolvedThreats ?? 0) + knownActiveThreats
  const hasProtectionBaseline = !!lastMalwareScan
  const updaterNeedsAttention = updaterRemindersEnabled && (!updaterHasChecked || pendingUpdateCount > 0)
  const hasCompletedCoreChecks = (!updaterRemindersEnabled || updaterHasChecked) && startupHasLoaded && hasProtectionBaseline
  const primaryDrive = drives.find((drive) => drive.isSystem)
  const primaryDriveUsedPercent = primaryDrive?.totalSize
    ? Math.round((primaryDrive.usedSpace / primaryDrive.totalSize) * 100)
    : diskPct
  const freeMemory = perf ? Math.max(0, perf.memTotalBytes - perf.memUsedBytes) : 0
  const attentionCount = Number(updaterNeedsAttention)
    + Number(!startupHasLoaded || startupAttentionCount > 0)
    + Number(!hasProtectionBaseline || unresolvedThreatCount > 0)
  const statusSentence = unresolvedThreatCount > 0
    ? t('heroStatusThreats', { count: unresolvedThreatCount })
    : !hasCompletedCoreChecks
      ? t('heroStatusIncomplete')
      : attentionCount === 0
        ? t('heroStatusHealthy')
        : t('heroStatusItems', { count: attentionCount })
  const healthTone = healthScore >= 80 ? 'good' : healthScore >= 55 ? 'ok' : 'low'
  const ramDetail = perf ? t('metricFree', { size: formatBytes(freeMemory) }) : t('metricChecking')
  const diskDetail = primaryDrive
    ? t('metricFree', { size: formatBytes(primaryDrive.totalSize - primaryDrive.usedSpace) })
    : driveStatus === 'loading'
      ? t('metricChecking')
      : t('metricUnavailable')
  const leftoverThreats = result ? Math.max(0, result.threatsFound - result.threatsQuarantined) : 0
  const resultEmpty = result
    && result.spaceRecovered === 0 && result.filesCleaned === 0 && result.registryFixed === 0
    && result.driversRemoved === 0 && result.threatsFound === 0 && result.privacyIssues === 0
    && result.startupHighImpact === 0 && result.updatesAvailable === 0

  const shortcuts = [
    { icon: Database, label: t('shortcutRegistry'), path: '/registry' },
    { icon: Eye, label: t('shortcutPrivacy'), path: '/privacy' },
    { icon: Cpu, label: t('shortcutDrivers'), path: '/drivers' },
    { icon: HardDrive, label: t('shortcutDisk'), path: '/disk' },
    { icon: Gamepad2, label: t('shortcutGameMode'), path: '/game-mode' },
    { icon: History, label: t('shortcutHistory'), path: '/history' }
  ]

  return (
    <div className="ert-home animate-fade-in">
      <header className="ert-home-hero">
        <div className="ert-home-hero-copy">
          <div className="ert-home-hero-title-row">
            <h1>{t('heroTitle')}</h1>
            <span
              className={cn('ert-home-health-badge', `is-${healthTone}`)}
              aria-label={t('healthBadgeLabel', { score: healthScore })}
            >
              {healthScore}
            </span>
          </div>
          <p>{statusSentence}</p>
        </div>
        <div className="ert-home-hero-actions">
          <button
            type="button"
            className="ert-home-btn ert-home-btn-primary"
            onClick={() => setShowQuickConfirm(true)}
            disabled={isRunning}
          >
            <Sparkles strokeWidth={1.9} />
            {t('oneClickClean')}
          </button>
          <button
            type="button"
            className="ert-home-btn ert-home-btn-secondary"
            onClick={() => setShowFullConfirm(true)}
            disabled={isRunning}
          >
            <Shield strokeWidth={1.9} />
            {t('fullScan')}
          </button>
        </div>
      </header>

      {isRunning && (
        <div className="ert-home-status" role="status">
          <div className="ert-home-status-row">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" strokeWidth={2} />
            <span>{phaseLabel || t('progressWorking')}</span>
            {stepProgress.total > 0 && <b>{stepProgress.current}/{stepProgress.total}</b>}
          </div>
          {stepProgress.total > 0 && (
            <div className="ert-home-status-track">
              <i style={{ width: `${(stepProgress.current / stepProgress.total) * 100}%` }} />
            </div>
          )}
        </div>
      )}

      {phase === 'done' && result && (
        <div
          className={cn('ert-home-status', leftoverThreats > 0 ? 'is-warning' : 'is-complete')}
          role="status"
        >
          {leftoverThreats > 0
            ? <AlertTriangle className="h-5 w-5 shrink-0" strokeWidth={1.8} />
            : <CheckCircle2 className="h-5 w-5 shrink-0" strokeWidth={1.8} />}
          <div className="min-w-0">
            <b>{leftoverThreats > 0 ? t('resultScanCompleteThreats') : t('resultCleanupComplete')}</b>
            <p>
              {result.spaceRecovered > 0 && <span>{t('resultSpaceRecovered', { size: formatBytes(result.spaceRecovered) })}</span>}
              {result.filesCleaned > 0 && <span>{t('resultFilesCleaned', { count: formatNumber(result.filesCleaned) })}</span>}
              {result.registryFixed > 0 && <span>{t('resultRegistryFixed', { count: formatNumber(result.registryFixed) })}</span>}
              {result.driversRemoved > 0 && <span>{t('resultDriversRemoved', { count: formatNumber(result.driversRemoved) })}</span>}
              {result.threatsQuarantined > 0 && (
                <button type="button" onClick={() => navigate('/malware', { state: { tab: 'quarantine' } })}>
                  {result.threatsQuarantined === 1
                    ? t('resultThreatsQuarantined', { count: result.threatsQuarantined })
                    : t('resultThreatsQuarantinedPlural', { count: result.threatsQuarantined })}
                </button>
              )}
              {leftoverThreats > 0 && (
                <button type="button" onClick={() => navigate('/malware')}>
                  {t('resultThreatsRemain', { count: leftoverThreats })}
                </button>
              )}
              {result.privacyIssues > 0 && (
                <button type="button" onClick={() => navigate('/privacy')}>
                  {result.privacyIssues === 1
                    ? t('resultPrivacyImprovements', { count: result.privacyIssues })
                    : t('resultPrivacyImprovementsPlural', { count: result.privacyIssues })}
                </button>
              )}
              {result.startupHighImpact > 0 && (
                <button type="button" onClick={() => navigate('/startup')}>
                  {result.startupHighImpact === 1
                    ? t('resultStartupHighImpact', { count: result.startupHighImpact })
                    : t('resultStartupHighImpactPlural', { count: result.startupHighImpact })}
                </button>
              )}
              {result.updatesAvailable > 0 && (
                <button type="button" onClick={() => navigate('/updates')}>
                  {result.updatesAvailable === 1
                    ? t('resultSoftwareUpdates', { count: result.updatesAvailable })
                    : t('resultSoftwareUpdatesPlural', { count: result.updatesAvailable })}
                </button>
              )}
              {resultEmpty && <span>{t('resultSystemAlreadyClean')}</span>}
            </p>
          </div>
        </div>
      )}

      <section className="ert-home-section" aria-labelledby="ert-home-metrics-heading">
        <h2 id="ert-home-metrics-heading">{t('metricsHeading')}</h2>
        <div className="ert-home-metrics">
          <MetricBar icon={Cpu} label={t('gaugeCpu')} percent={Math.round(cpuPct)} />
          <MetricBar icon={MemoryStick} label={t('gaugeRam')} percent={Math.round(ramPct)} detail={ramDetail} />
          <MetricBar icon={HardDrive} label={t('gaugeDisk')} percent={primaryDriveUsedPercent} detail={diskDetail} />
        </div>
      </section>

      <section className="ert-home-section" aria-labelledby="ert-home-attention-heading">
        <div className="ert-home-section-head">
          <h2 id="ert-home-attention-heading">{t('attentionHeading')}</h2>
          {attentionCount > 0 && <b className="ert-home-attention-count">{attentionCount}</b>}
        </div>
        <div className="ert-home-attention">
          {updaterRemindersEnabled && (
            <button type="button" onClick={() => navigate('/updates')}>
              <span className={cn('ert-home-attention-icon', updaterHasChecked && pendingUpdateCount === 0 && 'is-success')}>
                {updaterHasChecked && pendingUpdateCount === 0 ? <Check /> : <Download />}
              </span>
              <span>
                <b>
                  {!updaterHasChecked
                    ? t('attentionUpdatesCheck')
                    : pendingUpdateCount > 0
                      ? t('attentionUpdatesPending', { count: pendingUpdateCount })
                      : t('attentionUpdatesOk')}
                </b>
                <small>
                  {!updaterHasChecked
                    ? t('attentionUpdatesHintCheck')
                    : pendingUpdateCount > 0
                      ? t('attentionUpdatesHintPending')
                      : t('attentionUpdatesHintOk')}
                </small>
              </span>
              <em>
                {!updaterHasChecked
                  ? t('attentionBadgeCheck')
                  : pendingUpdateCount > 0
                    ? t('attentionBadgeReview')
                    : t('attentionBadgeDone')}
              </em>
            </button>
          )}
          <button type="button" onClick={() => navigate('/startup')}>
            <span className={cn('ert-home-attention-icon', startupHasLoaded && startupAttentionCount === 0 && 'is-success')}>
              {startupHasLoaded && startupAttentionCount === 0 ? <Check /> : <Zap />}
            </span>
            <span>
              <b>
                {!startupHasLoaded
                  ? t('attentionStartupCheck')
                  : startupAttentionCount > 0
                    ? t('attentionStartupPending', { count: startupAttentionCount })
                    : t('attentionStartupOk')}
              </b>
              <small>
                {!startupHasLoaded
                  ? t('attentionStartupHintCheck')
                  : startupAttentionCount > 0
                    ? t('attentionStartupHintPending')
                    : t('attentionStartupHintOk')}
              </small>
            </span>
            <em>
              {!startupHasLoaded
                ? (startupLoading ? t('attentionBadgeChecking') : t('attentionBadgeCheck'))
                : startupAttentionCount > 0
                  ? t('attentionBadgeReview')
                  : t('attentionBadgeDone')}
            </em>
          </button>
          <button type="button" onClick={() => navigate('/malware')}>
            <span className={cn('ert-home-attention-icon', hasProtectionBaseline && unresolvedThreatCount === 0 && 'is-success', unresolvedThreatCount > 0 && 'is-danger')}>
              {hasProtectionBaseline && unresolvedThreatCount === 0 ? <Check /> : <Shield />}
            </span>
            <span>
              <b>
                {unresolvedThreatCount > 0
                  ? t('attentionMalwareThreats', { count: unresolvedThreatCount })
                  : !hasProtectionBaseline
                    ? t('attentionMalwareFirst')
                    : t('attentionMalwareOk')}
              </b>
              <small>
                {unresolvedThreatCount > 0
                  ? t('attentionMalwareHintThreats')
                  : !hasProtectionBaseline
                    ? t('attentionMalwareHintFirst')
                    : lastMalwareScan
                      ? t('attentionMalwareHintLastScan', { date: formatDate(lastMalwareScan.completedAt) })
                      : t('attentionMalwareHintOk')}
              </small>
            </span>
            <em>
              {unresolvedThreatCount > 0
                ? t('attentionBadgeReview')
                : !hasProtectionBaseline
                  ? t('attentionBadgeStart')
                  : t('attentionBadgeDone')}
            </em>
          </button>
        </div>
      </section>

      <section className="ert-home-section" aria-labelledby="ert-home-shortcuts-heading">
        <h2 id="ert-home-shortcuts-heading">{t('shortcutsHeading')}</h2>
        <div className="ert-home-shortcuts">
          {shortcuts.map(({ icon: Icon, label, path }) => (
            <button
              key={path}
              type="button"
              className="ert-home-shortcut"
              onClick={() => navigate(path)}
            >
              <span className="ert-home-shortcut-icon"><Icon strokeWidth={1.8} /></span>
              <span>
                <b>{label}</b>
                {path === '/game-mode' && (
                  <small>
                    {gameModeActive && gameModeActivatedAt
                      ? formatGmElapsed(gmElapsed)
                      : t('shortcutGameModeHint')}
                  </small>
                )}
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="ert-home-stats" aria-label={t('statsHeading')}>
        <div>
          <span>{t('statSpaceRecovered')}</span>
          <b>{formatBytes(stats.totalSpaceSaved)}</b>
        </div>
        <div>
          <span>{t('statFilesCleaned')}</span>
          <b>{formatNumber(stats.totalFilesCleaned)}</b>
        </div>
        <div>
          <span>{t('statTotalScans')}</span>
          <b>{formatNumber(stats.totalScans)}</b>
        </div>
      </section>

      <ConfirmDialog
        open={showQuickConfirm}
        onConfirm={() => { setShowQuickConfirm(false); handleQuickClean() }}
        onCancel={() => setShowQuickConfirm(false)}
        title={t('quickCleanConfirmTitle')}
        description={features.registry ? t('quickCleanConfirmDescriptionWithRegistry') : t('quickCleanConfirmDescriptionWithoutRegistry')}
        confirmLabel={t('quickCleanConfirmLabel')}
        variant="warning"
      />

      <ConfirmDialog
        open={showFullConfirm}
        onConfirm={() => { setShowFullConfirm(false); handleFullClean() }}
        onCancel={() => setShowFullConfirm(false)}
        title={t('fullCleanConfirmTitle')}
        description={features.registry ? t('fullCleanConfirmDescriptionWithRegistry') : t('fullCleanConfirmDescriptionWithoutRegistry')}
        confirmLabel={t('fullCleanConfirmLabel')}
        variant="warning"
      />
    </div>
  )
}

function MetricBar({ icon: Icon, label, percent, detail }: {
  icon: typeof Cpu
  label: string
  percent: number
  detail?: string
}) {
  const clamped = Math.max(0, Math.min(100, percent))
  const tone = clamped >= 85 ? 'danger' : clamped >= 60 ? 'warning' : 'ok'
  return (
    <div className={cn('ert-home-metric', `is-${tone}`)}>
      <div className="ert-home-metric-head">
        <span><Icon strokeWidth={1.8} />{label}</span>
        <b>{clamped}%</b>
      </div>
      <div className="ert-home-metric-track" role="meter" aria-label={label} aria-valuenow={clamped} aria-valuemin={0} aria-valuemax={100}>
        <i style={{ width: `${clamped}%` }} />
      </div>
      {detail && <small>{detail}</small>}
    </div>
  )
}
