/**
 * ORB2 build script — bundles the TypeScript source into a single
 * distributable JS file using Bun's bundler.
 *
 * Handles:
 * - bun:bundle feature() flags for the open build
 * - MACRO.* globals → inlined version/build-time constants
 * - src/ path aliases
 */

import { readFileSync, existsSync as existsSyncPre } from 'fs'

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))
const version = pkg.version

// Feature flags for the open build.
// Most Anthropic-internal features stay off; open-build features can be
// selectively enabled here when their full source exists in the mirror.
const featureFlags: Record<string, boolean> = {
  VOICE_MODE: true,           // Voice STT — fully present in source
  PROACTIVE: false,
  KAIROS: false,
  BRIDGE_MODE: false,
  DAEMON: false,
  AGENT_TRIGGERS: false,
  MONITOR_TOOL: false,
  ABLATION_BASELINE: false,
  DUMP_SYSTEM_PROMPT: false,
  CACHED_MICROCOMPACT: true,  // Cached micro-compact — fully present in source
  COORDINATOR_MODE: true,     // Coordinator mode — fully present in source
  CONTEXT_COLLAPSE: true,     // Context collapse — fully present in source
  COMMIT_ATTRIBUTION: false,
  TEAMMEM: false,
  UDS_INBOX: false,
  BG_SESSIONS: false,
  AWAY_SUMMARY: false,
  TRANSCRIPT_CLASSIFIER: false,
  WEB_BROWSER_TOOL: false,
  MESSAGE_ACTIONS: false,
  BUDDY: true,
  CHICAGO_MCP: false,
  COWORKER_TYPE_TELEMETRY: false,
}

const sharedBuildOptions = {
  outdir: './dist',
  target: 'bun' as const,
  format: 'esm' as const,
  splitting: false,
  sourcemap: 'none' as const,
  minify: true,
}

const canvasWorkerEntrypoint = existsSyncPre('./src/entrypoints/canvas-worker.ts')
  ? ['./src/entrypoints/canvas-worker.ts']
  : []
const result = await Bun.build({
  ...sharedBuildOptions,
  entrypoints: ['./src/entrypoints/api.ts', ...canvasWorkerEntrypoint],
  naming: '[name].mjs',
  define: {
    // MACRO.* build-time constants
    // Keep the internal compatibility version high enough to pass
    // first-party minimum-version guards, but expose the real package
    // version separately in ORB2 branding.
    'MACRO.VERSION': JSON.stringify('99.0.0'),
    'MACRO.DISPLAY_VERSION': JSON.stringify(version),
    'MACRO.BUILD_TIME': JSON.stringify(new Date().toISOString()),
    'MACRO.ISSUES_EXPLAINER':
      JSON.stringify('report the issue at https://github.com/[owner]/orb2/issues'),
    'MACRO.PACKAGE_URL': JSON.stringify('orb2'),
    'MACRO.NATIVE_PACKAGE_URL': 'undefined',
  },
  plugins: [
    {
      name: 'bun-bundle-shim',
      setup(build) {
        // Resolve `import { feature } from 'bun:bundle'` to a shim
        build.onResolve({ filter: /^bun:bundle$/ }, () => ({
          path: 'bun:bundle',
          namespace: 'bun-bundle-shim',
        }))
        build.onLoad(
          { filter: /.*/, namespace: 'bun-bundle-shim' },
          () => ({
            contents: `const featureFlags = ${JSON.stringify(featureFlags)};\nexport function feature(name) { return featureFlags[name] ?? false; }`,
            loader: 'js',
          }),
        )

        // Resolve react/compiler-runtime to the standalone package
        build.onResolve({ filter: /^react\/compiler-runtime$/ }, () => ({
          path: 'react/compiler-runtime',
          namespace: 'react-compiler-shim',
        }))
        build.onLoad(
          { filter: /.*/, namespace: 'react-compiler-shim' },
          () => ({
            contents: `export function c(size) { return new Array(size).fill(Symbol.for('react.memo_cache_sentinel')); }`,
            loader: 'js',
          }),
        )

        // All optional/native/not-installed packages are stubbed so the
        // single-file bundle (cli.mjs) works without node_modules at runtime.
        // Installed packages (OpenTelemetry core, AWS bedrock-runtime,
        // google-auth-library, etc.) are bundled directly into cli.mjs.
        for (const mod of [
          'audio-capture-napi',
          'audio-capture.node',
          'image-processor-napi',
          'modifiers-napi',
          'url-handler-napi',
          'color-diff-napi',
          'asciichart',
          'plist',
          'cacache',
          'fuse',
          'code-excerpt',
          'stack-utils',
          // Native image processing — has .node binaries, cannot bundle
          'sharp',
          // Not-installed cloud provider packages (stubbed; installed ones are bundled)
          '@aws-sdk/client-bedrock',
          '@aws-sdk/client-sts',
          '@azure/identity',
          // Not-installed OpenTelemetry exporters (core + grpc + logs-http are bundled)
          '@opentelemetry/exporter-trace-otlp-http',
          '@opentelemetry/exporter-trace-otlp-proto',
          '@opentelemetry/exporter-logs-otlp-proto',
          '@opentelemetry/exporter-logs-otlp-grpc',
          '@opentelemetry/exporter-metrics-otlp-proto',
          '@opentelemetry/exporter-metrics-otlp-grpc',
          '@opentelemetry/exporter-metrics-otlp-http',
          '@opentelemetry/exporter-prometheus',
        ]) {
          build.onResolve({ filter: new RegExp(`^${mod}$`) }, () => ({
            path: mod,
            namespace: 'native-stub',
          }))
        }
        build.onLoad(
          { filter: /.*/, namespace: 'native-stub' },
          () => ({
            // Comprehensive stub that handles any named export via Proxy
            contents: `
const noop = () => null;
const noopClass = class {};
const handler = {
  get(_, prop) {
    if (prop === '__esModule') return true;
    if (prop === 'default') return new Proxy({}, handler);
    if (prop === 'ExportResultCode') return { SUCCESS: 0, FAILED: 1 };
    if (prop === 'resourceFromAttributes') return () => ({});
    if (prop === 'SandboxRuntimeConfigSchema') return { parse: () => ({}) };
    return noop;
  }
};
const stub = new Proxy(noop, handler);
export default stub;
export const __stub = true;
// Named exports for all known imports
export const SandboxViolationStore = null;
export const SandboxManager = new Proxy({}, { get: () => noop });
export const SandboxRuntimeConfigSchema = { parse: () => ({}) };
export const BROWSER_TOOLS = [];
export const getMcpConfigForManifest = noop;
export const ColorDiff = null;
export const ColorFile = null;
export const getSyntaxTheme = noop;
export const plot = noop;
export const createOrb2ForChromeMcpServer = noop;
// OpenTelemetry exports
export const ExportResultCode = { SUCCESS: 0, FAILED: 1 };
export const resourceFromAttributes = noop;
export const Resource = noopClass;
export const SimpleSpanProcessor = noopClass;
export const BatchSpanProcessor = noopClass;
export const NodeTracerProvider = noopClass;
export const BasicTracerProvider = noopClass;
export const OTLPTraceExporter = noopClass;
export const OTLPLogExporter = noopClass;
export const OTLPMetricExporter = noopClass;
export const PrometheusExporter = noopClass;
export const LoggerProvider = noopClass;
export const SimpleLogRecordProcessor = noopClass;
export const BatchLogRecordProcessor = noopClass;
export const MeterProvider = noopClass;
export const PeriodicExportingMetricReader = noopClass;
export const trace = { getTracer: () => ({ startSpan: () => ({ end: noop, setAttribute: noop, setStatus: noop, recordException: noop }) }) };
export const context = { active: noop, with: (_, fn) => fn() };
export const SpanStatusCode = { OK: 0, ERROR: 1, UNSET: 2 };
export const ATTR_SERVICE_NAME = 'service.name';
export const ATTR_SERVICE_VERSION = 'service.version';
export const SEMRESATTRS_SERVICE_NAME = 'service.name';
export const SEMRESATTRS_SERVICE_VERSION = 'service.version';
export const AggregationTemporality = { CUMULATIVE: 0, DELTA: 1 };
export const DataPointType = { HISTOGRAM: 0, SUM: 1, GAUGE: 2 };
export const InstrumentType = { COUNTER: 0, HISTOGRAM: 1, UP_DOWN_COUNTER: 2 };
export const PushMetricExporter = noopClass;
export const SeverityNumber = {};
// Cloud provider SDK exports (not-installed packages)
export const BedrockClient = noopClass;
export const STSClient = noopClass;
export const GetCallerIdentityCommand = noopClass;
export const AssumeRoleCommand = noopClass;
export const DefaultAzureCredential = noopClass;
export const ManagedIdentityCredential = noopClass;
export const ClientSecretCredential = noopClass;
export const getBearerTokenProvider = noop;
// sharp
export const sharp = noop;
`,
            loader: 'js',
          }),
        )

        // Resolve .md and .txt file imports to empty string stubs
        build.onResolve({ filter: /\.(md|txt)$/ }, (args) => ({
          path: args.path,
          namespace: 'text-stub',
        }))
        build.onLoad(
          { filter: /.*/, namespace: 'text-stub' },
          () => ({
            contents: `export default '';`,
            loader: 'js',
          }),
        )

        // Pre-scan: find all missing modules that need stubbing
        // (Bun's onResolve corrupts module graph even when returning null,
        //  so we use exact-match resolvers instead of catch-all patterns)
        const fs = require('fs')
        const pathMod = require('path')
        const srcDir = pathMod.resolve(__dirname, '..', 'src')
        const missingModules = new Set<string>()
        const missingModuleExports = new Map<string, Set<string>>()

        // Scan source to find imports that can't resolve
        function scanForMissingImports() {
          function walk(dir: string) {
            for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
              const full = pathMod.join(dir, ent.name)
              if (ent.isDirectory()) { walk(full); continue }
              if (!/\.(ts|tsx)$/.test(ent.name)) continue
              const code: string = fs.readFileSync(full, 'utf-8')
              // Collect all imports
              for (const m of code.matchAll(/import\s+(?:\{([^}]*)\}|(\w+))?\s*(?:,\s*\{([^}]*)\})?\s*from\s+['"](.*?)['"]/g)) {
                const specifier = m[4]
                const namedPart = m[1] || m[3] || ''
                const names = namedPart.split(',')
                  .map((s: string) => s.trim().replace(/^type\s+/, ''))
                  .filter((s: string) => s && !s.startsWith('type '))

                // Check src/tasks/ non-relative imports
                if (specifier.startsWith('src/tasks/')) {
                  const resolved = pathMod.resolve(__dirname, '..', specifier)
                  const candidates = [
                    resolved,
                    `${resolved}.ts`, `${resolved}.tsx`,
                    resolved.replace(/\.js$/, '.ts'), resolved.replace(/\.js$/, '.tsx'),
                    pathMod.join(resolved, 'index.ts'), pathMod.join(resolved, 'index.tsx'),
                  ]
                  if (!candidates.some((c: string) => fs.existsSync(c))) {
                    missingModules.add(specifier)
                  }
                }
                // Check relative .js imports
                else if (specifier.endsWith('.js') && (specifier.startsWith('./') || specifier.startsWith('../'))) {
                  const dir2 = pathMod.dirname(full)
                  const resolved = pathMod.resolve(dir2, specifier)
                  const tsVariant = resolved.replace(/\.js$/, '.ts')
                  const tsxVariant = resolved.replace(/\.js$/, '.tsx')
                  if (!fs.existsSync(resolved) && !fs.existsSync(tsVariant) && !fs.existsSync(tsxVariant)) {
                    missingModules.add(specifier)
                  }
                }

                // Track named exports for missing modules
                if (names.length > 0) {
                  if (!missingModuleExports.has(specifier)) missingModuleExports.set(specifier, new Set())
                  for (const n of names) missingModuleExports.get(specifier)!.add(n)
                }
              }
            }
          }
          walk(srcDir)
        }
        scanForMissingImports()

        // Register exact-match resolvers for each missing module
        for (const mod of missingModules) {
          const escaped = mod.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          build.onResolve({ filter: new RegExp(`^${escaped}$`) }, () => ({
            path: mod,
            namespace: 'missing-module-stub',
          }))
        }

        build.onLoad(
          { filter: /.*/, namespace: 'missing-module-stub' },
          (args) => {
            const names = missingModuleExports.get(args.path) ?? new Set()
            const exports = [...names].map(n => `export const ${n} = noop;`).join('\n')
            return {
              contents: `
const noop = () => null;
export default noop;
${exports}
`,
              loader: 'js',
            }
          },
        )
      },
    },
  ],
  // Optional runtime deps that @whiskeysockets/baileys require()s inside
  // try/catch (QR rendering, image transforms, link previews). Not installed
  // and not needed for the bridge's core path; mark external so the bundler
  // doesn't fail resolving them.
  external: ['qrcode-terminal', 'jimp', 'link-preview-js'],
})

if (!result.success) {
  console.error('Build failed:')
  for (const log of result.logs) {
    console.error(log)
  }
  process.exit(1)
}

// Copy the .proto descriptor alongside the bundle — the API server
// transitively imports gRPC types from the same source tree.
import { mkdirSync, copyFileSync, cpSync, readdirSync, rmSync } from 'fs'
mkdirSync('./proto', { recursive: true })
if (existsSync('./src/proto/orb2.proto')) {
  mkdirSync('./proto', { recursive: true })
  copyFileSync('./src/proto/orb2.proto', './proto/orb2.proto')
}

// SPA was extracted into the orb2-ui repo in v0.3.0. When src/web/ is
// still present (during the split transition, or for local single-pod
// dev) we keep copying it; otherwise the bundle ships without one.
if (existsSyncPre('./src/web')) {
  mkdirSync('./dist/web', { recursive: true })
  cpSync('./src/web', './dist/web', { recursive: true })
}

// Copy skill markdown files so the loader can read them at runtime.
// Clean first so removed skills (e.g. the old internal ones) don't linger
// as stale artifacts baked into the image.
rmSync('./dist/skills', { recursive: true, force: true })
mkdirSync('./dist/skills', { recursive: true })
for (const f of readdirSync('./src/api/skills').filter(f => f.endsWith('.md'))) {
  copyFileSync(`./src/api/skills/${f}`, `./dist/skills/${f}`)
}
console.log(`✓ Copied skills → dist/skills/`)

import { existsSync } from 'fs'

// Copy security reference files.
const securityRefsSrc = './src/api/skills/security-references'
if (existsSync(securityRefsSrc)) {
  cpSync(securityRefsSrc, './dist/security-references', { recursive: true })
  console.log(`✓ Copied security-references → dist/security-references/`)
}

// Copy documentation files so the console can serve them.
for (const docFile of ['README.md', 'ARCHITECTURE.md']) {
  if (existsSync(`./${docFile}`)) {
    copyFileSync(`./${docFile}`, `./dist/${docFile}`)
  }
}

console.log(`✓ Built orb2 API v${version} → dist/api.mjs`)
if (existsSyncPre('./dist/canvas-worker.mjs')) {
  console.log(`✓ Built canvas-worker → dist/canvas-worker.mjs`)
}
if (existsSyncPre('./dist/web')) {
  console.log(`✓ Copied SPA → dist/web/ (legacy single-pod mode)`)
}
console.log(`✓ Copied proto descriptor → proto/orb2.proto`)
