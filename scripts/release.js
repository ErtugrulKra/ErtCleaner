#!/usr/bin/env node

const { execSync } = require('child_process')
const { readFileSync, writeFileSync } = require('fs')

const RELEASE_TAG = /^v\d+\.\d+\.\d+$/
const EXACT_VERSION = /^\d+\.\d+\.\d+$/
const RENDERED_TYPES = /^(feat|fix|perf|revert)(\(.+\))?!?:/
const USAGE = 'Usage: npm run release -- patch|minor|major|<version>\n' +
  'Examples: npm run release -- patch    npm run release -- 0.1.2'

const run = (cmd) => execSync(cmd, { stdio: 'inherit' })
const capture = (cmd) => execSync(cmd, { encoding: 'utf-8' }).trim()

function parseReleaseArg(arg) {
  if (['patch', 'minor', 'major'].includes(arg)) return { type: 'bump', value: arg }
  if (typeof arg === 'string' && EXACT_VERSION.test(arg)) return { type: 'exact', value: arg }
  return null
}

function isReleaseTag(tag) {
  return RELEASE_TAG.test(tag)
}

function listTags(raw) {
  if (!raw) return []
  return raw.split(/\r?\n/).filter(Boolean)
}

function malformedReleaseTags(tags) {
  return tags.filter((tag) => tag.startsWith('v') && !isReleaseTag(tag))
}

function previousReleaseTag(tags) {
  const valid = tags.filter(isReleaseTag)
  if (valid.length === 0) return null
  return valid.sort((a, b) => {
    const pa = a.slice(1).split('.').map(Number)
    const pb = b.slice(1).split('.').map(Number)
    for (let i = 0; i < 3; i++) {
      if (pa[i] !== pb[i]) return pa[i] - pb[i]
    }
    return 0
  }).at(-1)
}

function main() {
  const spec = parseReleaseArg(process.argv[2])
  if (!spec) {
    console.error(USAGE)
    process.exit(1)
  }

  const status = capture('git status --porcelain')
  if (status) {
    console.error('Error: working tree is not clean. Commit or stash changes first.')
    process.exit(1)
  }

  const branch = capture('git rev-parse --abbrev-ref HEAD')
  if (branch !== 'master') {
    console.error(`Error: releases must be made from master branch (currently on ${branch})`)
    process.exit(1)
  }

  run('git fetch origin master --tags')
  const behind = capture('git rev-list HEAD..origin/master --count')
  if (behind !== '0') {
    console.error('Error: local master is behind origin. Pull first.')
    process.exit(1)
  }

  const tags = listTags(capture('git tag --list "v*"'))
  const badTags = malformedReleaseTags(tags)
  if (badTags.length > 0) {
    console.error('Error: malformed version tag(s) would poison changelog generation:')
    for (const tag of badTags) console.error(`  ${tag}`)
    console.error('\nExpected tags like v0.1.2 (no extra dot after v). Delete them first:')
    for (const tag of badTags) {
      console.error(`  git tag -d ${tag}`)
      console.error(`  git push origin :refs/tags/${tag}`)
    }
    process.exit(1)
  }

  run(`npm version ${spec.value} --no-git-tag-version`)

  const version = JSON.parse(readFileSync('package.json', 'utf-8')).version
  const tag = `v${version}`
  if (!isReleaseTag(tag)) {
    console.error(`Error: produced tag '${tag}' is not vMAJOR.MINOR.PATCH. Reverting.`)
    run('git checkout -- package.json package-lock.json')
    process.exit(1)
  }
  if (tags.includes(tag)) {
    console.error(`Error: tag ${tag} already exists. Reverting the version bump.`)
    run('git checkout -- package.json package-lock.json')
    process.exit(1)
  }
  console.log(`\nBumped to ${tag}`)

  const previousTag = previousReleaseTag(tags)
  const logRange = previousTag ? `${previousTag}..HEAD` : 'HEAD'
  const subjects = capture(`git log ${logRange} --no-merges --format=%s`)
    .split('\n')
    .filter(Boolean)
  const expectedEntries = subjects.filter((s) => RENDERED_TYPES.test(s))

  const changelogBefore = readFileSync('CHANGELOG.md', 'utf-8')
  run('npx conventional-changelog -p angular -i CHANGELOG.md')

  const changelogAfter = readFileSync('CHANGELOG.md', 'utf-8')
  const added = changelogAfter.slice(0, changelogAfter.length - changelogBefore.length)
  const wroteEntries = /^\s*[*-]\s+\S/m.test(added)

  if (expectedEntries.length > 0 && !wroteEntries) {
    console.error(`\nError: changelog generation produced no entries for ${tag}.`)
    console.error(`${expectedEntries.length} commit(s) since ${previousTag || 'the start of history'} should have appeared:\n`)
    for (const s of expectedEntries) console.error(`  ${s}`)
    console.error('\nWhat was written instead:\n')
    console.error(added.trim() || '  (nothing)')
    console.error('\nThis usually means the changelog preset failed to load. Check that the')
    console.error('conventional-changelog-angular version hoisted to the top of node_modules')
    console.error('is the one conventional-changelog depends on:\n')
    console.error('  npm ls conventional-changelog-angular\n')
    console.error('Nothing has been committed or pushed; reverting the version bump.')
    writeFileSync('CHANGELOG.md', changelogBefore)
    run('git checkout -- package.json package-lock.json')
    process.exit(1)
  }

  if (expectedEntries.length === 0) {
    console.log(`Changelog updated (no user-facing commits since ${previousTag || 'the start of history'})`)
  } else {
    console.log(`Changelog updated (${expectedEntries.length} entr${expectedEntries.length === 1 ? 'y' : 'ies'})`)
  }

  run('git add package.json package-lock.json CHANGELOG.md')
  run(`git commit -m "chore(release): ${version}"`)
  run(`git tag ${tag}`)
  run('git push origin master')
  run(`git push origin ${tag}`)

  console.log(`\n${tag} released! CI will build and publish.`)
}

if (require.main === module) {
  main()
}

module.exports = {
  parseReleaseArg,
  isReleaseTag,
  malformedReleaseTags,
  previousReleaseTag,
  RELEASE_TAG,
}
