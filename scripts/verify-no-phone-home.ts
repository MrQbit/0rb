import { existsSync, readFileSync } from 'node:fs'

const DIST = 'dist/api.mjs'
// Guard: the self-hosted build must never phone home. Fail the build if any
// external analytics / telemetry sink leaks into the bundle. (Local k8s
// secret/mount reads are legitimate for in-cluster ClusterOps and are not
// listed here.)
const BANNED_PATTERNS = [
  'datadoghq.com',
  'api/event_logging/batch',
] as const

if (!existsSync(DIST)) {
  console.error(`ERROR: ${DIST} not found. Run 'bun run build' first.`)
  process.exit(1)
}

const contents = readFileSync(DIST, 'utf8')
let exitCode = 0

console.log(`Checking ${DIST} for banned patterns...`)
console.log('')

for (const pattern of BANNED_PATTERNS) {
  const count = contents.split(pattern).length - 1
  if (count > 0) {
    console.log(`  FAIL: '${pattern}' found (${count} occurrences)`)
    exitCode = 1
  } else {
    console.log(`  PASS: '${pattern}' not found`)
  }
}

console.log('')

if (exitCode === 0) {
  console.log('✓ All checks passed — no banned patterns in build output')
} else {
  console.log('✗ FAILED — banned patterns found in build output')
}

process.exit(exitCode)
