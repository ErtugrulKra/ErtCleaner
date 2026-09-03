#!/usr/bin/env node

const { readFileSync, existsSync } = require('fs')
const { join } = require('path')

const ROOT = join(__dirname, '..')
const errors = []

function read(rel) {
  const path = join(ROOT, rel)
  if (!existsSync(path)) {
    errors.push(`missing file: ${rel}`)
    return ''
  }
  return readFileSync(path, 'utf8')
}

function mustContain(rel, text, haystack) {
  if (!haystack.includes(text)) {
    errors.push(`${rel} must contain ${JSON.stringify(text)}`)
  }
}

function mustNotContain(rel, text, haystack) {
  if (haystack.includes(text)) {
    errors.push(`${rel} must not contain ${JSON.stringify(text)}`)
  }
}

const security = read('SECURITY.md')
mustContain('SECURITY.md', 'github.com/ErtugrulKra/ErtCleaner/releases', security)
mustNotContain('SECURITY.md', 'CODE_SIGNING_POLICY.md', security)

const readmeTr = read('README.md')
mustContain('README.md', 'README.EN.md', readmeTr)
mustContain('README.md', 'SECURITY.md', readmeTr)
mustContain('README.md', 'github.com/ErtugrulKra/ErtCleaner/releases', readmeTr)
mustContain('README.md', 'Kaldır', readmeTr)
mustContain('README.md', 'Uninstall ErtCleaner.exe', readmeTr)
mustNotContain('README.md', 'CODE_SIGNING_POLICY.md', readmeTr)

const readmeEn = read('README.EN.md')
mustContain('README.EN.md', 'README.md', readmeEn)
mustContain('README.EN.md', 'SECURITY.md', readmeEn)
mustContain('README.EN.md', 'github.com/ErtugrulKra/ErtCleaner/releases', readmeEn)
mustContain('README.EN.md', 'Uninstall', readmeEn)
mustContain('README.EN.md', 'Uninstall ErtCleaner.exe', readmeEn)
mustNotContain('README.EN.md', 'CODE_SIGNING_POLICY.md', readmeEn)

if (existsSync(join(ROOT, 'CODE_SIGNING_POLICY.md'))) {
  errors.push('CODE_SIGNING_POLICY.md must not exist')
}

if (errors.length > 0) {
  for (const err of errors) console.error(err)
  process.exit(1)
}

console.log('release documentation checks passed')
