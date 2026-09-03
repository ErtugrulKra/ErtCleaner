import type { PlatformProvider } from './types'
import { createWin32Provider } from './win32'

let _provider: PlatformProvider | null = null

/**
 * Returns the Windows platform provider.
 * Lazy-initialized singleton — safe to call repeatedly.
 */
export function getPlatform(): PlatformProvider {
  if (_provider) return _provider
  _provider = createWin32Provider()
  return _provider
}

// Re-export types for convenience
export type { PlatformProvider } from './types'
