/**
 * RAK00N Managed Credential Installer
 *
 * This script is compiled into a standalone native binary (bun build --compile)
 * and distributed separately from the main rak00n binary.
 *
 * At install time it:
 *   1. Reads the encrypted credential blob (built into this binary at compile time)
 *   2. Decrypts it using the build secret (also built in at compile time)
 *   3. Writes each credential to the OS keychain
 *   4. Reports success/failure without echoing any key material
 *
 * The RAK00N_BUILD_SECRET is embedded at compile time via --define:
 *   bun build --compile \
 *     --define 'RAK00N_BUILD_SECRET_DEFINE="<secret>"' \
 *     installer/index.ts
 *
 * Never distribute the source of this file with real secrets embedded.
 */

import { createDecipheriv, createHash } from 'crypto'
import { execFileSync } from 'child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

import { ENCRYPTED_CREDENTIALS as GENERATED_ENCRYPTED_CREDENTIALS } from './credentials.enc.js'

// ─── Build-time constants (injected via --define at compile time) ─────────────
// In development these fall back to env vars so tests work without a real secret.
declare const RAK00N_BUILD_SECRET_DEFINE: string

const BUILD_SECRET: string = (() => {
  try { return RAK00N_BUILD_SECRET_DEFINE } catch { return process.env.RAK00N_BUILD_SECRET ?? '' }
})()

const ENCRYPTED_BLOB_RAW: string = GENERATED_ENCRYPTED_CREDENTIALS

const EMBEDDED_CLI_MJS_BASE64: string = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const payload = require('./payload.generated.js') as {
      EMBEDDED_CLI_MJS_BASE64?: string
    }
    return payload.EMBEDDED_CLI_MJS_BASE64 ?? ''
  } catch {
    return ''
  }
})()

// ─── Key derivation ───────────────────────────────────────────────────────────

const APP_SALT = 'rak00n.managed.credentials.v1'

function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret + APP_SALT).digest()
}

// ─── Decryption ───────────────────────────────────────────────────────────────

interface SlotData {
  slot: string
  apiKey: string
  endpoint: string
  model: string
  label: string
}

interface EncryptedBlob {
  version: number
  iv: string
  authTag: string
  ciphertext: string
  buildTime: string
  slotCount: number
}

function decryptCredentials(blob: EncryptedBlob, secret: string): SlotData[] {
  const key = deriveKey(secret)
  const iv = Buffer.from(blob.iv, 'base64')
  const authTag = Buffer.from(blob.authTag, 'base64')
  const ciphertext = Buffer.from(blob.ciphertext, 'base64')

  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return JSON.parse(plaintext.toString('utf8'))
}

// ─── Keychain writes ──────────────────────────────────────────────────────────

function execSilent(cmd: string, args: string[], input?: string): boolean {
  try {
    execFileSync(cmd, args, {
      stdio: input !== undefined ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      input,
      timeout: 8000,
      encoding: 'utf8',
    })
    return true
  } catch {
    return false
  }
}

const SERVICE = 'app.rak00n'
const ACCOUNT = 'rak00n'

function writeKeychain(slot: string, key: string, value: string): boolean {
  const fullSlot = `${SERVICE}.${slot}${key ? `.${key}` : ''}`

  switch (process.platform) {
    case 'darwin': {
      // Remove existing entry first, then add fresh
      execSilent('security', ['delete-generic-password', '-a', ACCOUNT, '-s', fullSlot])
      return execSilent('security', [
        'add-generic-password', '-a', ACCOUNT, '-s', fullSlot, '-w', value, '-U',
      ])
    }
    case 'linux': {
      return execSilent('secret-tool', ['store', '--label', `RAK00N ${fullSlot}`, 'rak00n', fullSlot], value)
    }
    case 'win32': {
      const script = `
[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]
$vault = New-Object Windows.Security.Credentials.PasswordVault
$escaped = '${value.replace(/'/g, "''")}'
try { $vault.Remove($vault.Retrieve('${fullSlot}', '${ACCOUNT}')) } catch {}
$vault.Add((New-Object Windows.Security.Credentials.PasswordCredential('${fullSlot}', '${ACCOUNT}', $escaped)))
`
      return execSilent('powershell', ['-NoProfile', '-Command', script])
    }
    default:
      return false
  }
}

function writeSlot(data: SlotData): { ok: boolean; errors: string[] } {
  const errors: string[] = []

  if (!writeKeychain(data.slot, '', data.apiKey)) errors.push(`api key for ${data.slot}`)
  if (!writeKeychain(data.slot, 'endpoint', data.endpoint)) errors.push(`endpoint for ${data.slot}`)
  if (!writeKeychain(data.slot, 'model', data.model)) errors.push(`model for ${data.slot}`)
  if (!writeKeychain(data.slot, 'label', data.label)) errors.push(`label for ${data.slot}`)

  return { ok: errors.length === 0, errors }
}

// ─── CLI install + PATH setup ───────────────────────────────────────────────

type InstallLayout = {
  rootDir: string
  binDir: string
  libDir: string
  cliPath: string
  launcherPath: string
}

function getInstallLayout(): InstallLayout {
  const rootDir = join(homedir(), '.rak00n')
  const binDir = join(rootDir, 'bin')
  const libDir = join(rootDir, 'lib')
  const cliPath = join(libDir, 'cli.mjs')
  const launcherPath =
    process.platform === 'win32'
      ? join(binDir, 'rak00n.cmd')
      : join(binDir, 'rak00n')

  return { rootDir, binDir, libDir, cliPath, launcherPath }
}

function hasNodeRuntime(): boolean {
  return execSilent('node', ['--version'])
}

function installCliPayload(layout: InstallLayout): boolean {
  if (!EMBEDDED_CLI_MJS_BASE64) {
    return false
  }

  mkdirSync(layout.binDir, { recursive: true })
  mkdirSync(layout.libDir, { recursive: true })

  const cliCode = Buffer.from(EMBEDDED_CLI_MJS_BASE64, 'base64').toString('utf8')
  writeFileSync(layout.cliPath, cliCode, 'utf8')

  if (process.platform === 'win32') {
    const launcher = [
      '@echo off',
      'setlocal',
      'set "RAK00N_HOME=%USERPROFILE%\\.rak00n"',
      'node "%RAK00N_HOME%\\lib\\cli.mjs" %*',
      'endlocal',
      '',
    ].join('\r\n')
    writeFileSync(layout.launcherPath, launcher, 'utf8')
    return true
  }

  const launcher = [
    '#!/usr/bin/env sh',
    'set -e',
    'RAK00N_HOME="${RAK00N_HOME:-$HOME/.rak00n}"',
    'exec node "$RAK00N_HOME/lib/cli.mjs" "$@"',
    '',
  ].join('\n')
  writeFileSync(layout.launcherPath, launcher, 'utf8')
  chmodSync(layout.launcherPath, 0o755)
  return true
}

function ensureUnixPathSetup(): { updated: string[] } {
  const exportLine = 'export PATH="$HOME/.rak00n/bin:$PATH"'
  const files = [join(homedir(), '.zshrc'), join(homedir(), '.bashrc')]
  const updated: string[] = []

  for (const file of files) {
    let content = ''
    if (existsSync(file)) {
      content = readFileSync(file, 'utf8')
    }
    if (content.includes('.rak00n/bin')) {
      continue
    }

    const next = `${content.trimEnd()}\n\n# Added by RAK00N installer\n${exportLine}\n`
    writeFileSync(file, next, 'utf8')
    updated.push(file)
  }

  return { updated }
}

function ensureWindowsPathSetup(layout: InstallLayout): boolean {
  const script = [
    '$target = [Environment]::GetFolderPath("UserProfile") + "\\.rak00n\\bin"',
    '$current = [Environment]::GetEnvironmentVariable("Path", "User")',
    'if ([string]::IsNullOrEmpty($current)) {',
    '  [Environment]::SetEnvironmentVariable("Path", $target, "User")',
    '} elseif (-not ($current -split ";" | Where-Object { $_ -eq $target })) {',
    '  [Environment]::SetEnvironmentVariable("Path", "$target;$current", "User")',
    '}',
  ].join('; ')

  const ok = execSilent('powershell', ['-NoProfile', '-Command', script])
  if (!ok) {
    return false
  }

  return true
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function printSuccess(layout: InstallLayout) {
  console.log('')
  console.log('════════════════════════════════════════')
  console.log('  ✓ RAK00N installed successfully')
  console.log('════════════════════════════════════════')
  console.log('')
  console.log(`  Launcher: ${layout.launcherPath}`)
  console.log(`  CLI:      ${layout.cliPath}`)
  console.log('')

  if (process.platform !== 'win32') {
    console.log('  To start using RAK00N, run:')
    console.log('')
    console.log('    source ~/.zshrc && rak00n')
    console.log('')
    console.log('  Or open a new terminal and run: rak00n')
  } else {
    console.log('  Open a new terminal and run: rak00n')
  }

  console.log('')
  console.log('  To use your own API key, set OPENAI_API_KEY or ANTHROPIC_API_KEY.')
  console.log('  Otherwise RAK00N will auto-configure a local Ollama instance.')
  console.log('')
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('RAK00N Installer\n')

  const layout = getInstallLayout()
  if (!hasNodeRuntime()) {
    console.error('Installation error: Node.js runtime is required to run the RAK00N CLI launcher.')
    console.error('Install Node.js 20+ first, then rerun this installer.')
    process.exit(1)
  }

  if (!installCliPayload(layout)) {
    console.error('Installation error: embedded CLI payload not found.')
    process.exit(1)
  }

  console.log('✓ CLI installed')

  if (process.platform === 'win32') {
    const pathOk = ensureWindowsPathSetup(layout)
    if (!pathOk) {
      console.error('Warning: failed to update PATH automatically on Windows.')
      console.error(`Add this directory manually to PATH: ${layout.binDir}`)
    }
  } else {
    const pathSetup = ensureUnixPathSetup()
    if (pathSetup.updated.length > 0) {
      console.log(`Updated shell startup files: ${pathSetup.updated.join(', ')}`)
    }
  }

  // Credential provisioning — optional. When no credentials are bundled
  // (no-credential build), the installer still installs the CLI and sets up
  // PATH. At runtime the CLI will auto-detect local Ollama or prompt the
  // user for provider configuration.
  const hasCredentials = !!(BUILD_SECRET && ENCRYPTED_BLOB_RAW)

  if (hasCredentials) {
    let blob: EncryptedBlob
    try {
      blob = JSON.parse(ENCRYPTED_BLOB_RAW)
    } catch {
      console.error('Warning: credential payload is malformed — skipping credential provisioning.')
      printSuccess(layout)
      process.exit(0)
    }

    let slots: SlotData[]
    try {
      slots = decryptCredentials(blob, BUILD_SECRET)
    } catch {
      console.error('Warning: credential decryption failed — skipping credential provisioning.')
      printSuccess(layout)
      process.exit(0)
    }

    console.log(`Provisioning ${slots.length} endpoint(s) to system keychain...\n`)

    let allOk = true
    for (const slot of slots) {
      const { ok, errors } = writeSlot(slot)
      if (ok) {
        console.log(`  ✓ ${slot.label} (${slot.slot})`)
      } else {
        console.error(`  ✗ ${slot.label} (${slot.slot}) — failed to write: ${errors.join(', ')}`)
        allOk = false
      }
    }

    console.log('')

    if (!allOk) {
      console.error('Some credentials could not be written.')
      console.error('Try running with elevated permissions, or configure keys manually.')
    }
  } else {
    console.log('No managed credentials bundled.')
    console.log('On first run, RAK00N will auto-configure a local Ollama instance')
    console.log('or prompt you to configure a provider.\n')
  }

  printSuccess(layout)
  process.exit(0)
}

main().catch(err => {
  console.error('Unexpected installation error:', err.message)
  process.exit(1)
})
