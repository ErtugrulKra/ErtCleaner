import { getSettings } from './services/settings-store'

import tr from '../renderer/src/locales/tr/tray.json'

const resources: Record<string, Record<string, string>> = { tr }

export function t(key: string, params?: Record<string, string | number>): string {
  let lang: string
  try {
    lang = getSettings().language || 'tr'
  } catch {
    lang = 'tr'
  }
  const str = resources[lang]?.[key] ?? resources.tr[key] ?? key
  if (!params) return str
  return str.replace(/\{\{(\w+)\}\}/g, (_, k) => String(params[k] ?? ''))
}
