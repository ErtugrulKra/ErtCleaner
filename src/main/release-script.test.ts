import { createRequire } from 'module'
import path from 'path'
import { describe, it, expect } from 'vitest'

const require = createRequire(import.meta.url)
const {
  parseReleaseArg,
  isReleaseTag,
  malformedReleaseTags,
  previousReleaseTag,
} = require(path.resolve(__dirname, '..', '..', 'scripts', 'release.js')) as {
  parseReleaseArg: (arg: string | undefined) => { type: 'bump' | 'exact'; value: string } | null
  isReleaseTag: (tag: string) => boolean
  malformedReleaseTags: (tags: string[]) => string[]
  previousReleaseTag: (tags: string[]) => string | null
}

describe('parseReleaseArg', () => {
  it('accepts conventional bumps', () => {
    expect(parseReleaseArg('patch')).toEqual({ type: 'bump', value: 'patch' })
    expect(parseReleaseArg('minor')).toEqual({ type: 'bump', value: 'minor' })
    expect(parseReleaseArg('major')).toEqual({ type: 'bump', value: 'major' })
  })

  it('accepts an explicit semver for skipping a botched tag', () => {
    expect(parseReleaseArg('0.1.2')).toEqual({ type: 'exact', value: '0.1.2' })
  })

  it('rejects the v.0.1.1 typo and other junk', () => {
    expect(parseReleaseArg('v.0.1.1')).toBeNull()
    expect(parseReleaseArg('v0.1.2')).toBeNull()
    expect(parseReleaseArg('0.1')).toBeNull()
    expect(parseReleaseArg(undefined)).toBeNull()
  })
})

describe('release tags', () => {
  it('accepts vMAJOR.MINOR.PATCH only', () => {
    expect(isReleaseTag('v0.1.2')).toBe(true)
    expect(isReleaseTag('v.0.1.1')).toBe(false)
    expect(isReleaseTag('v0.1.1-beta')).toBe(false)
  })

  it('flags the extra-dot typo as malformed', () => {
    expect(malformedReleaseTags(['v0.1.0', 'v.0.1.1', 'v0.1.2'])).toEqual(['v.0.1.1'])
  })

  it('picks the highest valid previous tag and ignores junk', () => {
    expect(previousReleaseTag(['v.0.1.1', 'v0.1.0', 'v0.0.9'])).toBe('v0.1.0')
    expect(previousReleaseTag(['v.0.1.1'])).toBeNull()
  })
})
