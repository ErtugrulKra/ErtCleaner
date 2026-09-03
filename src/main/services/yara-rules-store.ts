/**
 * Optional local YARA rule metadata. Remote signature download is disabled.
 */
export const RULES_ENDPOINT = '/api/yara-rules'

export interface YaraRulesMetadata {
  version: string
  updatedAt: string
  rulesCount: number
  sha256: string
}

export function getCachedRulePaths(): string[] {
  return []
}

export function getAllRulePaths(): string[] {
  return []
}

export function getRulesMetadata(): YaraRulesMetadata | null {
  return null
}

export function startPeriodicRuleChecks(
  _serverUrl: string,
  _onUpdated: () => void,
  _intervalMs?: number,
): void {}

export function stopPeriodicRuleChecks(): void {}

export async function fetchAndCacheRules(_url: string): Promise<{
  success: boolean
  error?: string
  stats?: { rulesCount: number; version: string }
}> {
  return { success: false, error: 'YARA imza güncellemesi devre dışı' }
}
