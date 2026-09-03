import type { UpdateStatus } from '../../shared/types'

const status: UpdateStatus = { state: 'idle' }

interface InitOptions {
  daemon?: boolean
}

export function initAutoUpdater(_opts: InitOptions = {}): void {
  // Auto-updater is disabled in ErtCleaner.
}

export function updateCheckInterval(_hours: number): void {}

export function checkForUpdates(): Promise<void> {
  return Promise.resolve()
}

export function downloadUpdate(): Promise<void> {
  return Promise.resolve()
}

export function installUpdate(): void {}

export function getUpdateStatus(): UpdateStatus {
  return status
}

export function setAutoDownload(_enabled: boolean): void {}
