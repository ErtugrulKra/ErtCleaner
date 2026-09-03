#!/usr/bin/env node

const { execSync } = require('child_process')
const { mkdirSync, existsSync } = require('fs')
const { join } = require('path')

const version = require('../package.json').version
const dist = join(__dirname, '..', 'dist')
if (!existsSync(dist)) mkdirSync(dist, { recursive: true })
const out = join(dist, `ErtCleaner-${version}.cdx.json`)
execSync(
  `npx cyclonedx-npm --output-reproducible --output-format JSON --mc-type application --output-file "${out}"`,
  { stdio: 'inherit', cwd: join(__dirname, '..') }
)
