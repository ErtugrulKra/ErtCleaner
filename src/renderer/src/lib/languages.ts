export const LANGUAGES = [
  { code: 'tr', name: 'Turkish', nativeName: 'Türkçe' },
] as const

export type LanguageCode = (typeof LANGUAGES)[number]['code']

export const RTL_LANGUAGES: readonly string[] = ['ar', 'he']
