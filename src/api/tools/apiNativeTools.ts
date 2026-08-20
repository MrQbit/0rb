/**
 * API-native agent tools.
 *
 * These tools need API-process state (Redis store, sessionId, ownerId)
 * or API-only capabilities (k8s/docker control, sandbox, vault, jobs).
 * They're built with that state bound and appended to the agent's tool
 * set via AgentRunInput.extraTools (see agentRunner.ts).
 *
 * The Tool shape mirrors the dynamic MCP-tool injection in
 * agentRunner.ts: a minimal object the QueryEngine accepts, with a
 * `call(args)` returning `{ data: string }`.
 */
import { z } from 'zod/v4'
import type { Store } from '../store/store.js'
import { executeSubmitJob } from '../jobs/tool.js'
import { executeRunCode, isSandboxEnabled } from '../sandbox/tool.js'
import {
  executeVaultRead,
  executeVaultWrite,
  executeVaultSearch,
} from '../vault/tools.js'
import {
  executeClusterOps,
  executeDockerOps,
  executeSelfUpdate,
  executeSelfBuild,
} from '../cluster/operators.js'
import { isInCluster } from '../cluster/k8sClient.js'
import { isDockerOpsEnabled } from '../cluster/dockerClient.js'
import { executeVision, visionToolAvailable } from '../vision/vision.js'
import { executeRecall, semanticMemoryEnabled } from '../memory/semantic.js'
import { executeSelfEvolve, selfModifyEnabled } from '../cluster/selfEvolve.js'
import { emitWidget } from '../widgets/bus.js'
import { bridgeEnabled } from '../connectors/bridge.js'
import { youtubeEnabled, youtubeSearch } from '../connectors/youtube.js'
import { spotifyEnabled, spotifySearch } from '../connectors/spotify.js'
import { spotifyApi, getUserToken } from '../connectors/spotifyOAuth.js'
import { newsEnabled, newsSearch } from '../connectors/news.js'
import { vercelEnabled, deployToVercel } from '../connectors/vercel.js'
import { cloudStorageEnabled, searchCloud, downloadCloudFile, connectedProviders } from '../connectors/cloudStorage.js'
import { geocode, route as geoRoute, weather, reverseGeocode } from '../connectors/geo.js'
import { webSearch, webSearchEnabled } from '../connectors/websearch.js'
import { haConfig, haAreas, haCreateArea, haUpdateEntity, haAreaByEntity, haJoinAreas, toDeviceCard, prettyDomain, describeAttrs, haConfigEntries, haDiscoveredFlows, haFlowAdvance, haFlowStart, haEntityRegistry, normalizeFlowResult, translateFlowView } from '../connectors/homeAssistant.js'
import { dockerEnabled, dockerList, dockerControl } from '../connectors/dockerc.js'
import { haEnabled, haStates, haResolve, haCallService, HOME_DOMAINS, type HaEntity } from '../connectors/homeAssistant.js'
import { onlineOptions, nearbyStores } from '../connectors/shopping.js'
import type { CloudProvider } from '../connectors/cloudStorageOAuth.js'

export type ApiToolContext = {
  store: Store
  sessionId: string
  ownerId: string
}

type ApiToolSpec = {
  name: string
  description: string
  inputJSONSchema: Record<string, unknown>
  readOnly?: boolean
  destructive?: boolean
  run: (args: any) => Promise<string>
}

function buildTool(spec: ApiToolSpec): any {
  const passthrough = z.object({}).passthrough()
  return {
    name: spec.name,
    async description() { return spec.description },
    async prompt() { return spec.description },
    inputSchema: passthrough,
    inputJSONSchema: spec.inputJSONSchema,
    isMcp: false,
    alwaysLoad: false,
    isReadOnly() { return spec.readOnly ?? false },
    isConcurrencySafe() { return spec.readOnly ?? false },
    isDestructive() { return spec.destructive ?? false },
    isOpenWorld() { return false },
    isSearchOrReadCommand() { return false },
    toAutoClassifierInput(input: any) { return JSON.stringify(input) },
    async checkPermissions() { return { behavior: 'allow' as const } },
    async call(args: Record<string, unknown>) {
      try {
        const data = await spec.run(args || {})
        return { data }
      } catch (err) {
        return { data: `[ERROR] ${(err as Error).message}` }
      }
    },
    mapToolResultToToolResultBlockParam(content: string, toolUseID: string) {
      return { tool_use_id: toolUseID, type: 'tool_result' as const, content }
    },
    renderToolResultMessage: undefined,
    renderToolUseMessage: undefined,
    renderToolUseProgressMessage: undefined,
    isResultTruncated() { return false },
    userFacingName() { return spec.name },
  }
}

/** JSON-schema definitions for the tools (also surfaced by /v1/tools). */
export function apiNativeToolDefs(): Array<{ name: string; description: string; input_schema: Record<string, unknown>; available: boolean }> {
  const defs = [
    {
      name: 'ClusterOps',
      description: 'Control the Kubernetes cluster orb2 runs inside: list pods/jobs/deployments, read pod logs, delete a pod/job, scale a deployment, check rollout status. Use for orchestrating worker jobs and canvas pods, and diagnosing cluster state.',
      input_schema: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['list_pods', 'list_jobs', 'list_deployments', 'pod_logs', 'delete_pod', 'delete_job', 'scale', 'rollout_status'] },
          name: { type: 'string', description: 'Resource name (pod/job/deployment) for ops that target one' },
          namespace: { type: 'string', description: 'Namespace (defaults to orb2\'s own)' },
          replicas: { type: 'number', description: 'Replica count for the "scale" op' },
          tail_lines: { type: 'number', description: 'Log tail line count for pod_logs (default 200)' },
        },
        required: ['op'],
      },
      available: isInCluster(),
    },
    {
      name: 'DockerOps',
      description: 'Control Docker on the host (DGX Spark): list/inspect/restart/stop/start containers. Requires the host docker socket; disabled unless ORB2_DOCKER_OPS_ENABLED=1.',
      input_schema: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['list', 'logs', 'restart', 'stop', 'start'] },
          container: { type: 'string', description: 'Container name or ID' },
          tail_lines: { type: 'number', description: 'Log tail for the "logs" op' },
        },
        required: ['op'],
      },
      available: isDockerOpsEnabled(),
    },
    {
      name: 'Widget',
      description: "The ONLY way to SHOW the user something visual — ALWAYS use this instead of describing structured data in prose, and instead of any other display tool. Multiple widgets can be open at once and the user drags them around. Pick the best 'type':\n• chart — bar/line/pie/doughnut from labels+datasets (use this for ANY chart/graph; do NOT write chart HTML by hand).\n• results — a list of search results/recommendations; each item has title/subtitle/thumbnail and an optional action (e.g. a video the user clicks to play, or a link).\n• video — play one video (youtube/vimeo/direct url).\n• table — columns + rows.\n• stats — a row of metric cards (label/value/sub).\n• gallery — a grid of images (click to enlarge).\n• image — one image with a caption.\n• embed — embed an external interactive page by URL (e.g. a Sketchfab 3D model, an OpenStreetMap map, a CodeSandbox). Use this to 'find me a 3D model' etc.\n• calculator — an interactive calculator (no data needed; use when the user wants to do math themselves).\n• weather — a weather card. PREFER the dedicated **Weather** tool (it fetches real data for a location and renders this card for you). Only build it directly if you already have the data: pass `location`, `current` ({temp, condition, humidity, wind}) and optional `forecast` ([{day, high, low, condition}]).\n• calendar — a month calendar with event dots + an agenda: pass optional `month` (YYYY-MM) and `events` ([{date: YYYY-MM-DD, time, title}]). Use for schedules/agendas.\n• map — an interactive map: pass `center` ([lat,lng]) + `zoom`, `markers` ([{lat, lng, label}]) for places, and `route` ([[lat,lng],…]) for a path/route. Use for 'where is…', directions, 'show me on a map'. To change the route, add a stop, or drop a hotel pin, re-emit the SAME id with the updated markers/route — it updates the one map, never a new one.\n• code — DISPLAY source code read-only with syntax highlighting + line numbers + copy (pass `code` and optional `language`/`filename`). Use this to SHOW code you wrote/found. (To RUN a bespoke app instead, use Canvas / the `html` type — code is display-only.)\n• mail — an inbox preview: `messages` ([{from, subject, snippet, date, unread}]).\n• vercel — deployment status: `deployments` ([{name, state, branch, url, created}]).\n• embed — embed an external interactive page by URL (e.g. a Sketchfab 3D model, an OpenStreetMap map, a CodeSandbox). Use this to 'find me a 3D model' etc.\n• html — a bespoke custom interactive app you hand-write: pass complete self-contained HTML in `html` (include any CDN libs like three.js/d3 in <script>). Renders in a draggable app card. Use this ONLY when no other type fits (a generated 3D scene, a simulation, a custom UI).\n• note — formatted markdown/text.",
      input_schema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['chart', 'results', 'video', 'music', 'table', 'stats', 'gallery', 'image', 'embed', 'calculator', 'weather', 'calendar', 'map', 'code', 'mail', 'vercel', 'html', 'note', 'document', 'wallet', 'shopping'], description: 'Widget kind.' },
          id: { type: 'string', description: "STRONGLY use a STABLE, SEMANTIC id per logical widget — e.g. 'map', 'weather', 'route', 'calendar', 'mail'. To CHANGE or EXTEND what is already shown (a different city's weather, add a hotel to the route, a new route), re-emit with the SAME id — this updates that widget IN PLACE and brings it back into view (even if it scrolled away or collapsed). NEVER open a second widget of the same kind; reuse its id. Omit only for a genuinely new, distinct thing." },
          html: { type: 'string', description: 'html: complete self-contained HTML document (with any CDN <script>/<link>) for a bespoke app.' },
          title: { type: 'string', description: 'Widget title shown in its header.' },
          chart_type: { type: 'string', enum: ['bar', 'line', 'pie', 'doughnut'], description: 'chart: chart style.' },
          labels: { type: 'array', items: { type: 'string' }, description: 'chart: x-axis / slice labels.' },
          datasets: { type: 'array', description: 'chart: [{ label, data: [numbers] }].' },
          items: { type: 'array', description: "results: [{ title, subtitle, thumbnail, action: { kind: 'video'|'link', url, provider } }]." },
          columns: { type: 'array', items: { type: 'string' }, description: 'table: column headers.' },
          rows: { type: 'array', description: 'table: array of row arrays (cells).' },
          stats: { type: 'array', description: 'stats: [{ label, value, sub }].' },
          images: { type: 'array', description: 'gallery: [{ url, caption }].' },
          url: { type: 'string', description: 'video/image/embed: the URL.' },
          caption: { type: 'string', description: 'image: caption.' },
          provider: { type: 'string', enum: ['youtube', 'vimeo', 'direct'], description: 'video: source kind.' },
          location: { type: 'string', description: 'weather: place name.' },
          current: { type: 'object', description: 'weather: { temp, condition, humidity, wind }.' },
          forecast: { type: 'array', description: 'weather: [{ day, high, low, condition }].' },
          month: { type: 'string', description: 'calendar: month to show as YYYY-MM (defaults to current).' },
          events: { type: 'array', description: 'calendar: [{ date: YYYY-MM-DD, time, title }].' },
          code: { type: 'string', description: 'code: the source to display (read-only, highlighted).' },
          language: { type: 'string', description: 'code: language hint (js, ts, py, …).' },
          filename: { type: 'string', description: 'code: optional filename shown in the bar.' },
          messages: { type: 'array', description: 'mail: [{ from, subject, snippet, date, unread }].' },
          deployments: { type: 'array', description: 'vercel: [{ name, state, branch, url, created }].' },
          center: { type: 'array', description: 'map: [lat, lng] center.' },
          zoom: { type: 'number', description: 'map: zoom level (1-19).' },
          markers: { type: 'array', description: 'map: [{ lat, lng, label }] place pins.' },
          route: { type: 'array', description: 'map: [[lat,lng],…] polyline for a route/path.' },
          pill: { type: 'string', description: 'optional short telemetry shown when the widget collapses to a pill (e.g. "3 unread", "CPU 12%").' },
          text: { type: 'string', description: 'note: markdown/plain text.' },
        },
        required: ['type'],
      },
      available: true,
    },
    {
      name: 'YouTubeSearch',
      description: "Search YouTube for videos (connected app). PREFER this over generic web search whenever the user wants a video, a clip, music videos, tutorials, news clips, etc. It shows a results widget where each item plays in a floating player on click. Returns the top results.",
      input_schema: { type: 'object', properties: { query: { type: 'string', description: 'What to search for on YouTube.' } }, required: ['query'] },
      available: youtubeEnabled(),
    },
    {
      name: 'MusicSearch',
      description: "Search Spotify for music — songs, artists, albums (connected app). PREFER this whenever the user wants to play/find music. Shows a results widget; clicking a track opens a Spotify player (full track if the listener is signed into Spotify, else a 30s preview). Returns the top tracks.",
      input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Song, artist, or album to find.' } }, required: ['query'] },
      available: spotifyEnabled(),
    },
    {
      name: 'MusicPlay',
      description: "Play music on the user's Spotify (requires their connected Spotify account + Premium). Pass a 'query' (song/artist) to find and play the top match, or a Spotify track 'uri'. Plays on the user's active device or the in-browser player. Use this when the user says 'play …'. Also shows the track widget.",
      input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Song/artist to play.' }, uri: { type: 'string', description: 'Spotify track URI (spotify:track:...) if known.' } } },
      available: spotifyEnabled(),
    },
    {
      name: 'MusicControl',
      description: "Control the user's Spotify playback (connected account): play, pause, next, previous, or set volume (0-100). Use for 'pause', 'skip', 'resume', 'turn it down', etc.",
      input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['play', 'pause', 'next', 'previous', 'volume'] }, volume: { type: 'number', description: 'for action=volume: 0-100.' } }, required: ['action'] },
      available: spotifyEnabled(),
    },
    {
      name: 'WebSearch',
      description: "Search the live web (private SearXNG). Use for ANY question about current events, prices, versions, releases, weather-adjacent news, or facts that may have changed since training — instead of saying you can't browse. Returns the top results (title, URL, snippet) and shows them in a results widget.",
      input_schema: { type: 'object', properties: {
        query: { type: 'string', description: 'What to search for.' },
        count: { type: 'number', description: 'Max results (default 8).' },
      }, required: ['query'] },
      available: webSearchEnabled(),
    },
    {
      name: 'NewsSearch',
      description: "Search the news (connected app). PREFER this over generic web search when the user wants news, headlines, or current events. Shows a results widget; clicking an article opens it. Pass a topic/query, or empty for top headlines.",
      input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Topic or query (empty = top headlines).' } } },
      available: newsEnabled(),
    },
    {
      name: 'Docker',
      description: "Inspect and control the host's Docker. action 'list' shows a live Docker widget (containers + state + CPU/mem) the user can also click; 'stop'/'start'/'restart' a container by name (`target`); 'pull' an `image`; 'logs' of a container. Use for 'what's running', 'stop X', 'restart the api', 'pull image Y'. Re-emits the same docker widget so it stays one panel.",
      input_schema: { type: 'object', properties: {
        action: { type: 'string', enum: ['list', 'stop', 'start', 'restart', 'pull', 'logs'] },
        target: { type: 'string', description: 'container name (for stop/start/restart/logs).' },
        image: { type: 'string', description: 'image (for pull).' },
      }, required: ['action'] },
      available: dockerEnabled(),
    },
    {
      name: 'Directions',
      description: "Plot driving directions on the map widget. Give a `from` and `to` place (and optional `stops`), and it geocodes them, computes the real route, and SHOWS it on the map (reusing the one map widget). Use for 'how do I get there', 'directions to…', 'route from A to B'. To add a stop/hotel along the way, call again with the extra place in `stops`. Returns distance + time.",
      input_schema: { type: 'object', properties: {
        from: { type: 'string', description: 'Start place/address (omit to start from `to` only as a single pin).' },
        to: { type: 'string', description: 'Destination place/address.' },
        stops: { type: 'array', items: { type: 'string' }, description: 'Optional intermediate stops (e.g. a hotel along the way).' },
      }, required: ['to'] },
      available: true,
    },
    {
      name: 'Geocode',
      description: "Look up the coordinates of a place/address (returns lat/lng). Use to place a single pin on the map, or to get coordinates before showing a map/weather for a location.",
      input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Place or address.' } }, required: ['query'] },
      available: true,
    },
    {
      name: 'Weather',
      description: "Get CURRENT conditions + a 5-day forecast for a place and SHOW it in the weather widget. Pass a `location` (city/place), or omit it for the user's home. It fetches REAL data (Open-Meteo, no key needed) and renders the card. ALWAYS use this for any weather/temperature/forecast question instead of telling the user to check a website. Reuses the one weather widget.",
      input_schema: { type: 'object', properties: { location: { type: 'string', description: 'City or place, e.g. "Austin, TX". Omit for the user\'s home location.' } } },
      available: true,
    },
    {
      name: 'CloudStorageSearch',
      description: "Search the user's connected cloud storage (Google Drive and/or Microsoft OneDrive) for files by name. Shows a results widget; returns the matches with their provider + file id. Use when the user references 'my drive', 'onedrive', 'a file in my cloud', etc. Pass an empty query for recent files. Then use CloudStoragePull to bring a file into the workspace.",
      input_schema: { type: 'object', properties: {
        query: { type: 'string', description: 'Filename or text to match (empty = recent files).' },
        provider: { type: 'string', enum: ['google', 'microsoft'], description: 'Optional: restrict to one provider. Omit to search all connected.' },
      } },
      available: cloudStorageEnabled(),
    },
    {
      name: 'CloudStoragePull',
      description: "Download a file from the user's cloud storage into the workspace so you (and the user) can open/read it. Provide the provider + file_id from CloudStorageSearch. Google Docs/Sheets/Slides are exported to PDF/CSV automatically. Returns the saved workspace path.",
      input_schema: { type: 'object', properties: {
        provider: { type: 'string', enum: ['google', 'microsoft'] },
        file_id: { type: 'string', description: 'The file id from CloudStorageSearch.' },
        name: { type: 'string', description: 'Optional filename override.' },
      }, required: ['provider', 'file_id'] },
      available: cloudStorageEnabled(),
    },
    {
      name: 'Blender',
      description: "Full 3D workshop (Blender). op:'build' (default): write a Blender Python (bpy) script that builds the scene — it's CLEARED each run, so re-send the FULL updated script with the SAME id to iterate; renders an interactive orbit/zoom widget and reports real dimensions. op:'render' {script | file}: a LIT studio still (camera + lights automatic) shown as an image — for beauty shots. op:'convert' {file, format:'stl'|'obj'|'fbx'|'glb'}: convert any mesh (STL/OBJ/PLY/FBX/glTF) — e.g. a downloaded STL becomes a viewable model, or a built model becomes an STL ready to slice for the 3D printer. op:'analyze' {file}: dimensions, volume, triangle count and WATERTIGHT check (3D-print readiness). `bpy`, `math`, `mathutils` pre-imported; never export in scripts — that's automatic.",
      input_schema: { type: 'object', properties: {
        op: { type: 'string', enum: ['build', 'render', 'convert', 'analyze'], description: 'Default build.' },
        script: { type: 'string', description: "build/render: bpy script building the full scene (pre-cleared)." },
        file: { type: 'string', description: 'render/convert/analyze: a mesh file in this session workspace (or a widget id like model-main).' },
        format: { type: 'string', enum: ['stl', 'obj', 'fbx', 'glb'], description: "convert: output format." },
        title: { type: 'string' },
        id: { type: 'string', description: 'build: reuse the same id to update the same model widget as you iterate.' },
      } },
      available: !!process.env.ORB2_BLENDER_URL,
    },
    {
      name: 'Publish',
      description: "Publish the CURRENT Canvas app to a public shareable link that anyone can open WITHOUT a orb2 account. Workflow: first build the page with the Canvas tool (assemble the charts/content the user wants to share into one self-contained HTML app), then call Publish. Returns the public URL. Use when the user asks to share/publish/send a page or report to someone.",
      input_schema: { type: 'object', properties: { title: { type: 'string', description: 'A title for the published page.' } } },
      available: true,
    },
    {
      name: 'RecallMemory',
      description: "Semantically search your long-term memory for things relevant to a query (meaning-based, paraphrase-aware — finds related memories even when wording differs). Use this to recall what you know about the user, past decisions, the system, or context before answering. Complements MEMORY.md.",
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to recall, in natural language.' },
          k: { type: 'number', description: 'Max results (default 6).' },
        },
        required: ['query'],
      },
      available: semanticMemoryEnabled(),
    },
    {
      name: 'Vision',
      description: "Look at what the user's camera is currently showing (a remote A/V stream). Call with no question for a full description of the live frame, or with a specific question (\"is anyone there?\", \"what's on the screen?\", \"read the text\", \"what color is the car?\"). Use this whenever the user refers to something they're showing you, or asks you to watch/look. Returns moondream2's answer; only the most recent frame is available.",
      input_schema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'Optional question about the current frame. Omit for a general description.' },
        },
      },
      available: visionToolAvailable(),
    },
    {
      name: 'SelfEvolve',
      description: "Rewrite and ship your OWN code (compose-native self-improvement). After you've edited your source under /src, call this to: build the edited source into a candidate image, boot it in a throwaway SANDBOX, health-check it, and — only if it passes and promote=true — promote it to the running prod instance with automatic rollback if the new version is unhealthy. Call with promote=false first to validate safely without touching prod; then promote=true to ship. Edit your source FIRST.",
      input_schema: {
        type: 'object',
        properties: {
          promote: { type: 'boolean', description: 'false (default): build + sandbox-test only. true: also promote to prod on success (with auto-rollback).' },
          timeout_s: { type: 'number', description: 'Max seconds for build + sandbox validation (default 600).' },
        },
      },
      available: selfModifyEnabled(),
    },
    {
      name: 'SelfUpdate',
      description: 'Update orb2\'s own running code: patch the Deployment to a new container image and watch the blue-green rollout to completion. Build and import the image FIRST (via Bash/sandbox), then call this with the image ref. With 2+ replicas the agent stays reachable throughout.',
      input_schema: {
        type: 'object',
        properties: {
          image: { type: 'string', description: 'New container image ref, e.g. orb2-api:dev-2' },
          deployment: { type: 'string', description: 'Deployment name (default orb2-api)' },
          container: { type: 'string', description: 'Container name (default orb2-api)' },
          timeout_s: { type: 'number', description: 'Max seconds to wait for rollout (default 180)' },
        },
        required: ['image'],
      },
      available: isInCluster(),
    },
    {
      name: 'SelfBuild',
      description: 'Full self-update build loop: build a new container image from orb2\'s own (already-edited, already-tested) source, import it into the k3d cluster, then roll it out via blue-green SelfUpdate. Edit + test your source FIRST. Requires host docker (ORB2_DOCKER_OPS_ENABLED=1). Set build_only:true to build+import without rolling out.',
      input_schema: {
        type: 'object',
        properties: {
          tag: { type: 'string', description: 'Image tag to build (default: timestamped)' },
          build_only: { type: 'boolean', description: 'Build + import only; do not roll out (default false)' },
          timeout_s: { type: 'number', description: 'Rollout timeout seconds (default 180)' },
        },
      },
      available: isInCluster() && isDockerOpsEnabled(),
    },
    {
      name: 'SubmitJob',
      description: 'Submit an async/long-running job (deployment, workflow, pipeline) for background execution. Runs via k8s worker or the in-process queue. Track it on your todo list and check status later.',
      input_schema: {
        type: 'object',
        properties: {
          type: { type: 'string', description: 'Job type: deploy, code-review, workflow, pipeline, etc.' },
          description: { type: 'string', description: 'What this job does' },
          params: { type: 'object', description: 'Job-specific parameters' },
          requires_approval: { type: 'boolean', description: 'Needs approval before execution (default true)' },
        },
        required: ['type', 'description'],
      },
      available: true,
    },
    {
      name: 'RunCode',
      description: 'Execute code in the sandbox (Python3 by default). Isolated, 30s timeout, 512KB output cap. Use for quick computation, data processing, or testing snippets without touching the workspace.',
      input_schema: {
        type: 'object',
        properties: {
          language: { type: 'string', description: 'Language (python3)' },
          code: { type: 'string', description: 'Source code to execute' },
          stdin: { type: 'string', description: 'Optional stdin' },
        },
        required: ['code'],
      },
      available: isSandboxEnabled(),
    },
    {
      name: 'VaultRead',
      description: 'Read a note from the knowledge vault (persistent cross-session memory).',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Note path, e.g. "decisions/tech-stack.md"' } },
        required: ['path'],
      },
      available: true,
    },
    {
      name: 'VaultWrite',
      description: 'Write/update a note in the knowledge vault. Persists durable facts, decisions, and patterns across sessions. Use [[wikilinks]] to link notes.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          aliases: { type: 'array', items: { type: 'string' } },
        },
        required: ['path', 'content'],
      },
      available: true,
    },
    {
      name: 'VaultSearch',
      description: 'Search the knowledge vault for relevant notes before starting work.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['query'],
      },
      available: true,
    },
    {
      name: 'Concierge',
      description: "Help the user buy something — 'where can I get a new lamp?', 'I need a coffee maker'. Returns ways to order it online (Amazon, Google Shopping, Walmart, eBay) AND nearby stores that likely sell it (shown on the map). Pass `near` (a place/address, or leave blank to use the home location) to include local shops. Use this for any 'where can I buy / get / order …' request.",
      input_schema: { type: 'object', properties: {
        query: { type: 'string', description: 'What the user wants to buy, e.g. "lamp", "coffee maker", "drill".' },
        near: { type: 'string', description: 'Place/address to search around for local stores (optional; defaults to the configured home location).' },
        mode: { type: 'string', enum: ['online', 'local', 'both'], description: 'online links, local stores, or both (default both).' },
      }, required: ['query'] },
      available: true,
    },
    {
      name: 'Home',
      description: "Control and check the home's devices through Home Assistant — lights, switches/plugs, thermostats (climate), locks, window shades/blinds (cover), TVs & speakers (media_player), robot vacuums, fans, and door/window & motion sensors. This is how Orb acts as the house. Use op:'list' to see what's available (optionally a `type`), op:'status' to check a device by name, and op:'control' to change one: action on/off/toggle for lights/plugs/switches; lock/unlock for locks; open/close (or set with `value` 0-100) for shades; set with `value` for a thermostat's target temperature; play/pause/on/off (or set volume with `value` 0-100) for media; start/stop/dock for a vacuum. Always refer to devices by their friendly name (e.g. \"kitchen lights\", \"front door\").",
      input_schema: { type: 'object', properties: {
        op: { type: 'string', enum: ['list', 'status', 'control', 'media', 'lights', 'climate', 'vacuum', 'covers', 'security', 'plugs', 'scenes', 'sensors', 'camera', 'presence', 'automations', 'printer', 'mode'], description: "list = overview dashboard; status/control = one device; each FUNCTION op shows a focused widget: media (TV/speaker remote), lights (room-grouped), climate (thermostats), vacuum, covers (shades/blinds), security (locks + door/window/motion sensors), plugs (switches/outlets), scenes, sensors (readings: temperature/humidity/battery), camera (snapshots), presence (who's home/away), automations (list HA automations with on/off + run), printer (3D printer: live camera, progress, temps, pause/stop); mode {mode:'home'|'away'|'vacation'|'guest', secure?:true} sets the HOUSE MODE — away/vacation = instant alerts incl. motion; guest = mute door nagging; secure:true when leaving also locks every lock and turns lights off (say what was done). Use for 'we're leaving', 'back home', 'guests are over'. ALWAYS prefer the function widget matching what the user is focused on — the overview dashboard (list) is for 'show me everything'." },
        query: { type: 'string', description: "Device name for status/control (e.g. 'living room lights', 'front door', 'bedroom thermostat')." },
        type: { type: 'string', enum: ['light', 'switch', 'climate', 'lock', 'cover', 'media_player', 'vacuum', 'fan', 'sensor', 'camera'], description: 'Optional device type filter for list.' },
        action: { type: 'string', enum: ['on', 'off', 'toggle', 'lock', 'unlock', 'open', 'close', 'play', 'pause', 'start', 'stop', 'dock', 'set'], description: 'What to do for op:control.' },
        value: { type: 'number', description: 'Numeric arg for set: brightness/position/volume 0-100, or thermostat temperature.' },
      }, required: ['op'] },
      available: haEnabled(),
    },
    {
      name: 'HomeAdmin',
      description: "Organize AND configure the smart home in Home Assistant. Structure: op:'areas' lists rooms; op:'create_area' {name}; op:'assign' {query, area}; op:'rename' {query, name}; op:'hide' {query, hidden}. Device setup: op:'integrations' lists installed integrations + devices HA has DISCOVERED on the network but not set up yet; op:'pair' {integration} advances a discovered device's setup (e.g. integration:'webostv' makes the TV show its pairing prompt — the device must be ON and the user must accept on its screen); op:'setup' {integration, fields?} starts a NEW integration from scratch (e.g. 'roomba') and reports what fields it needs — pass them in `fields` on the next call; op:'diagnose' {query} explains why a device is failing (state, availability, which integration). op:'dismiss' {integration} clears a discovered-device suggestion you don't want (e.g. the generic 'ipp' twin of an already-set-up printer). op:'suggest' analyzes the household's actual device usage patterns (last week of history) and returns a digest — study it, propose 2-3 CONCRETE automations conversationally (e.g. 'the living room light comes on around 19:00 most days — want that automatic at sunset?'), and only after the user agrees create them with op:'automate'. op:'automate' {alias, triggers, actions, conditions?} CREATES a Home Assistant automation from JSON you write (HA automation schema: triggers like {trigger:'time',at:'22:00'} or {trigger:'state',entity_id,to}, actions like {action:'light.turn_off',target:{entity_id}}) — confirm the plan with the user BEFORE creating. op:'cleanup' hides duplicate entities when one physical device was registered by several integrations (Sonos/TVs often triple-register via Cast/DLNA — native wins). Use these to actively FIX devices instead of telling the user to open HA. HYGIENE: after pairing a new device, always (1) rename it to a clean human name, (2) assign it to its room, (3) run cleanup.",
      input_schema: { type: 'object', properties: {
        op: { type: 'string', enum: ['areas', 'create_area', 'assign', 'rename', 'hide', 'integrations', 'pair', 'setup', 'diagnose', 'cleanup', 'dismiss', 'automate', 'suggest'] },
        query: { type: 'string', description: 'Device to act on, by name.' },
        area: { type: 'string', description: "Room name for op:'assign'." },
        name: { type: 'string', description: "New display name for op:'rename' / op:'create_area'." },
        hidden: { type: 'boolean', description: "op:'hide': true hides, false unhides." },
        integration: { type: 'string', description: "Integration handler for pair/setup/dismiss, e.g. 'webostv', 'roomba', 'ipp'." },
        fields: { type: 'object', description: "op:'setup': answers for the fields the flow asked for (e.g. {host:'192.168.1.20'})." },
        alias: { type: 'string', description: "op:'automate': human name for the automation." },
        triggers: { type: 'array', description: "op:'automate': HA trigger list.", items: { type: 'object' } },
        actions: { type: 'array', description: "op:'automate': HA action list.", items: { type: 'object' } },
        conditions: { type: 'array', description: "op:'automate': optional HA condition list.", items: { type: 'object' } },
      }, required: ['op'] },
      available: haEnabled(),
    },
    {
      name: 'AirPlay',
      description: "The DEFAULT way to speak or play audio on speakers & TVs: AirPlay devices found DIRECTLY on the network, zero setup (works even for devices Home Assistant doesn't know). op:'list' shows every AirPlay device (and network printer) the LAN bridge sees. op:'say' {device, text} speaks a message on a speaker (TTS, e.g. \"tell the living room dinner is ready\"). op:'play' {device, url} streams an audio URL (internet radio, a music file). op:'stop' stops playback; op:'volume' {device, level:0-100}. Refer to devices by name (e.g. 'living room'). PREFER this over the Home tool for playback/announcements; fall back to Home (HA) only for what AirPlay can't do — TV power/inputs, media browsing, grouped scenes.",
      input_schema: { type: 'object', properties: {
        op: { type: 'string', enum: ['list', 'say', 'play', 'stop', 'volume'] },
        device: { type: 'string', description: "Speaker/TV name (fuzzy matched), e.g. 'living room'." },
        text: { type: 'string', description: "op:'say': the message to speak." },
        url: { type: 'string', description: "op:'play': direct URL of an audio stream or file (mp3/wav/flac/ogg)." },
        level: { type: 'number', description: "op:'volume': 0-100." },
      }, required: ['op'] },
      available: bridgeEnabled(),
    },
    {
      name: 'Print',
      description: "Print DIRECTLY to network printers (IPP/AirPrint) — no Home Assistant or driver setup. op:'list' shows printers with the formats they accept; op:'status' {printer} checks state (idle/printing/stopped + reasons like low toner); op:'print' {printer, text} prints plain text, or {printer, file} prints a workspace file — ONLY in a format the printer advertises (a PDF is refused if the printer only takes raster; say so honestly rather than printing garbage).",
      input_schema: { type: 'object', properties: {
        op: { type: 'string', enum: ['list', 'status', 'print'] },
        printer: { type: 'string', description: 'Printer name (fuzzy matched); optional when only one printer exists.' },
        text: { type: 'string', description: "op:'print': plain text to print." },
        file: { type: 'string', description: "op:'print': path of a file in this session's workspace." },
      }, required: ['op'] },
      available: bridgeEnabled(),
    },
    {
      name: 'Receipts',
      description: "The household action ledger — everything Orb has DONE (who asked, what changed, when), with undo. op:'list' shows recent actions as a widget; op:'undo' reverses the most recent undoable action (or a specific one by id) — use when the user says 'undo that', 'turn it back', 'what did you just do?'.",
      input_schema: { type: 'object', properties: {
        op: { type: 'string', enum: ['list', 'undo'] },
        id: { type: 'string', description: 'Specific receipt id to undo (default: most recent undoable).' },
      }, required: ['op'] },
      available: true,
    },
    {
      name: 'Settings',
      description: "Read and change Orb's own settings, and open the Settings panel for the user. op:'open' {section?} opens the panel (sections: access, users, channels, voice, apps, files, integrations, system). op:'get' {key?} reads current settings (secret values are shown only as set/unset). op:'connect' {value:<pasted credential>} auto-detects WHICH service a pasted API key/token belongs to by its shape and wires it into the right setting (use whenever the user pastes a key without saying where it goes — if ambiguous it returns the candidates to ask about). op:'set' {key, value} changes a setting live (e.g. OPENAI_MODEL, ORB2_TTS_VOICE, ORB2_HOME_LOCATION, OPENAI_BASE_URL for a cloud brain). Use when the user asks to change how Orb works — do it for them instead of describing where to click. Endpoint/key changes may need a restart to fully apply.",
      input_schema: { type: 'object', properties: {
        op: { type: 'string', enum: ['open', 'get', 'set', 'connect'] },
        section: { type: 'string', description: "Panel section for op:'open'." },
        key: { type: 'string', description: 'Setting key (ORB2_* / OPENAI_*).' },
        value: { type: 'string', description: "New value for op:'set'." },
      }, required: ['op'] },
      available: true,
    },
    {
      name: 'Family',
      description: "The household: notes between members, a shared family calendar, reminders for each other, and announcements over the speakers. op:'note' {to, text, when:'next'|'home'} leaves a note delivered on their next chat ('next') or when they arrive home ('home'). op:'board' shows the family board widget. op:'remind' {to, label, minutes|at} sets a reminder that notifies THAT member on their channel. op:'calendar_add' {title, date:'YYYY-MM-DD', time?, who?, repeat?:'yearly' for birthdays/anniversaries (auto-rolls every year)} and op:'calendar' (show) manage the shared household calendar (no external account). op:'calendar_remove' {query}. op:'announce' {message, where?} speaks a message on the home's speakers ('dinner is ready!'); where narrows to a room or speaker name ('living room', 'kitchen sonos'). op:'members' lists the household. op:'pref' {key, value} saves a personal preference for the CURRENT user (nickname, style, tastes — honoured in their future chats; empty value deletes; special key 'arrival_scene' = an HA scene activated when THEY arrive home); op:'prefs' lists theirs. Chores: op:'chore_add' {title, to, day?(0-6 weekly)}, op:'chore_done' {query}, op:'chores' shows the rota. ROUTINES (recurring care reminders — medication, pet feeding, plant watering): op:'routine_add' {label, at:'HH:MM', to, days?:[0-6]} fires EVERY day (or listed weekdays) at that time to that member's channel; op:'routines' lists; op:'routine_remove' {query}. op:'briefing' shows the day-at-a-glance widget (weather, today's events, chores, security, who's home) — use for 'good morning', 'what's my day', 'morning briefing'. Resolve people by first name.",
      input_schema: { type: 'object', properties: {
        op: { type: 'string', enum: ['note', 'board', 'remind', 'calendar_add', 'calendar', 'calendar_remove', 'announce', 'members', 'pref', 'prefs', 'chore_add', 'chore_done', 'chores', 'briefing', 'routine_add', 'routines', 'routine_remove'] },
        to: { type: 'string', description: 'Member (name or email) for note/remind.' },
        text: { type: 'string', description: 'Note text.' },
        when: { type: 'string', enum: ['next', 'home'], description: "note delivery: next chat (default) or arrives-home." },
        label: { type: 'string' }, minutes: { type: 'number' }, at: { type: 'string' },
        title: { type: 'string' }, date: { type: 'string' }, time: { type: 'string' }, who: { type: 'string' },
        message: { type: 'string', description: 'What to announce aloud.' },
        query: { type: 'string' },
        key: { type: 'string', description: "Preference name for op:'pref'." },
        value: { type: 'string', description: "Preference value (empty deletes)." },
        day: { type: 'number', description: 'Weekly chore day 0-6 (Sun-Sat).' },
      }, required: ['op'] },
      available: true,
    },
    {
      name: 'Timer',
      description: "Timers, alarms and time-based reminders — use for ANY 'set a timer', 'remind me in/at', 'wake me', 'alarm' request. op:'set' {label, minutes} or {label, at:'HH:MM'} (24h, today/tomorrow if past); op:'list'; op:'cancel' {query}. Shows the countdown widget; when it fires the owner is notified on their channels even if the app is closed.",
      input_schema: { type: 'object', properties: {
        op: { type: 'string', enum: ['set', 'list', 'cancel'] },
        label: { type: 'string', description: "What it's for — 'pasta', 'stand-up meeting'." },
        minutes: { type: 'number', description: 'Duration from now.' },
        at: { type: 'string', description: "Absolute time 'HH:MM' (24h)." },
        query: { type: 'string', description: 'Timer to cancel, by label.' },
      }, required: ['op'] },
      available: true,
    },
    {
      name: 'Shopping',
      description: "The user's shopping list + buying flow (Amazon and grocery/other). op:'show' displays the shopping widget; op:'add' {items:[{name,qty?,note?}]} adds to the list; op:'remove' {query} removes by name; op:'options' {query} researches buy options with prices (web search + merchant links) and shows them in the widget — use this when the user hasn't named an exact product; op:'checkout' {query?} produces checkout links — Amazon items check out in the user's own Amazon account, other merchants via their site with the Wallet for payment choice. NEVER claim an order was placed — Orb hands off to the merchant, the user completes payment there.",
      input_schema: { type: 'object', properties: {
        op: { type: 'string', enum: ['show', 'add', 'remove', 'options', 'checkout'] },
        items: { type: 'array', description: "op:'add': [{name, qty?, note?, every_days?}] or plain strings. every_days makes it a STAPLE that re-adds itself that many days after being checked off (auto grocery reorder — 'we buy milk weekly' → every_days:7).", items: { type: ['object', 'string'] } },
        query: { type: 'string', description: 'Item name for remove/options/checkout.' },
      }, required: ['op'] },
      available: true,
    },
    {
      name: 'CreateWidget',
      description: "Create a brand-new REUSABLE widget type when NO existing Widget type fits the data you must display. Workflow: 1) call op:'template' to get a starter render.js and the exact contract; 2) adapt it and call op:'install' with {id, name, icon, render_js}; 3) display data with the Widget tool using type:<your id> — every field you put in that Widget spec is available to your render.js as `spec`. render.js MUST export `function render(el, spec, api)` — build DOM inside `el`, escape any text you interpolate with api.esc(). Self-contained only: no external scripts, no network. op:'list' shows installed custom widgets; op:'remove' {id} deletes one.",
      input_schema: { type: 'object', properties: {
        op: { type: 'string', enum: ['template', 'install', 'list', 'remove'] },
        id: { type: 'string', description: 'Short kebab-case type id, e.g. "recipe-card".' },
        name: { type: 'string', description: 'Human name shown in Settings → Apps.' },
        icon: { type: 'string', description: 'One emoji.' },
        render_js: { type: 'string', description: 'The full render.js source.' },
      }, required: ['op'] },
      available: true,
    },
    {
      name: 'Wallet',
      description: "The user's payment methods — use whenever asked to buy, pay, order, or check out. op:'show' opens the wallet widget so the user can SEE and SELECT how to pay (always do this before any purchase step); op:'list' returns the methods as text; op:'selected' returns the currently chosen method. Orb stores only labels/brand/last4 — never card numbers — and actual payment always happens in the user's own Apple Pay / Google Pay sheet or the merchant checkout, never automatically.",
      input_schema: { type: 'object', properties: {
        op: { type: 'string', enum: ['show', 'list', 'selected'] },
      }, required: ['op'] },
      available: true,
    },
  ]
  return defs
}

/** Build the bound, agent-callable Tool objects for a turn. */
export function buildApiNativeTools(ctx: ApiToolContext): any[] {
  const defs = apiNativeToolDefs()
  const byName = new Map(defs.map(d => [d.name, d]))
  const tools: any[] = []

  const add = (name: string, opts: { readOnly?: boolean; destructive?: boolean }, run: (args: any) => Promise<string>) => {
    const def = byName.get(name)!
    if (!def.available) return
    // The trust layer (v0.2 §2): classify → (approve) → run → receipt.
    const wrapped = async (args: any): Promise<string> => {
      const { effectiveImpact, requestApproval, recordReceipt, actionKey } = await import('../policy/policy.js')
      const { summarizeAction, captureInverse } = await import('../policy/describe.js')
      const user = ctx.ownerId || 'owner'
      let impact: Awaited<ReturnType<typeof effectiveImpact>>
      try { impact = await effectiveImpact(ctx.store, user, name, args) } catch { impact = 'read' }
      if (impact === 'read') return run(args)
      if (impact === 'never-auto') return "I can't do that autonomously — it needs to be done by hand."
      const summary = summarizeAction(name, args)
      const inverse = await captureInverse(ctx.store, name, args)
      if (impact === 'confirm') {
        const { approved } = await requestApproval(ctx.store, ctx.sessionId, user, name, args,
          summary, 'This action is gated — approve it on screen.')
        if (!approved) return `Not approved — I didn't do it (${summary}).`
      }
      const result = await run(args)
      if (!/^\[ERROR|^\[Home Assistant\]|failed/i.test(result.slice(0, 40))) {
        recordReceipt(ctx.store, { user, tool: name, key: actionKey(name, args), summary, inverse })
          .catch(() => { /* the action already happened; never fail it on ledger IO */ })
      }
      return result
    }
    tools.push(buildTool({
      name: def.name,
      description: def.description,
      inputJSONSchema: def.input_schema,
      readOnly: opts.readOnly,
      destructive: opts.destructive,
      run: wrapped,
    }))
  }

  add('Widget', { readOnly: true }, async args => {
    const id = (typeof args?.id === 'string' && args.id.trim()) ? args.id.trim() : `w-${Date.now().toString(36)}`
    // Bespoke HTML app → write a self-contained file to the workspace and
    // render it as an 'app' iframe widget (served with the permissive canvas
    // CSP so CDN libs like three.js work).
    if (args?.type === 'html' && typeof args.html === 'string' && args.html.trim()) {
      try {
        const { mkdir, writeFile } = await import('node:fs/promises')
        const { join } = await import('node:path')
        const wsRoot = process.env.ORB2_API_WORKSPACE_ROOT || '/workspace'
        const dir = join(wsRoot, ctx.sessionId, '.widget')
        await mkdir(dir, { recursive: true })
        await writeFile(join(dir, `${id}.html`), args.html)
        emitWidget(ctx.sessionId, { id, type: 'app', title: args.title || 'App', url: `/v1/workspace/${ctx.sessionId}/.widget/${id}.html` } as any)
        return `Displayed a custom app widget${args.title ? ` ("${args.title}")` : ''}.`
      } catch (e) {
        return `[ERROR] could not render the app widget: ${(e as Error).message}`
      }
    }
    // Map guard: models routinely invent coordinates (usually [0,0] — "Null
    // Island", open ocean off Africa). Trust only real-looking coords; when
    // the spec carries a place STRING (or nothing), geocode it server-side —
    // falling back to the user's home — so the map always lands somewhere true.
    if (args?.type === 'map') {
      const looksReal = (c: any) => Array.isArray(c) && c.length === 2 &&
        Number.isFinite(Number(c[0])) && Number.isFinite(Number(c[1])) &&
        !(Math.abs(Number(c[0])) < 0.5 && Math.abs(Number(c[1])) < 0.5)
      const hasMarkers = Array.isArray(args.markers) && args.markers.some((m: any) => looksReal([m?.lat, m?.lng ?? m?.lon ?? m?.longitude]))
      if (!hasMarkers && !looksReal(args.center)) {
        const place = String(args.location || args.query || args.title || '').trim() || (await homeLocation()) || ''
        const g = place ? await geocode(place).catch(() => null) : null
        if (!g) return `[ERROR] I don't have real coordinates for that map. Use the Geocode tool first (or pass location:"<place name>") — never invent lat/lng.`
        args = { ...args, center: [g.lat, g.lng], zoom: args.zoom || 12, markers: [{ lat: g.lat, lng: g.lng, label: g.name?.split(',')[0] || place }] }
      }
    }
    emitWidget(ctx.sessionId, { ...args, id } as any)
    const verb = (typeof args?.id === 'string' && args.id.trim()) ? 'Updated' : 'Displayed a'
    return `${verb} ${args?.type || 'widget'} widget (id: ${id}). To update THIS SAME widget later, call Widget again with id:"${id}".`
  })
  add('YouTubeSearch', { readOnly: true }, async args => {
    const q = String(args?.query || '').trim()
    if (!q) return 'Provide a query.'
    try {
      const res = await youtubeSearch(q, 8)
      if (!res.length) return `No YouTube results for "${q}".`
      emitWidget(ctx.sessionId, {
        id: `yt-${Date.now().toString(36)}`, type: 'results', title: `YouTube · ${q}`,
        items: res.map(r => ({ title: r.title, subtitle: r.channel, thumbnail: r.thumbnail, action: { kind: 'video', url: r.url, provider: 'youtube' } })),
      } as any)
      return `Showed ${res.length} YouTube results for "${q}" (each plays on click). Top: ${res.slice(0, 3).map(r => r.title).join('; ')}.`
    } catch (e) { return `[ERROR] YouTube search failed: ${(e as Error).message}` }
  })
  add('MusicSearch', { readOnly: true }, async args => {
    const q = String(args?.query || '').trim()
    if (!q) return 'Provide a query.'
    try {
      const res = await spotifySearch(q, 8)
      if (!res.length) return `No Spotify tracks for "${q}".`
      emitWidget(ctx.sessionId, {
        id: `sp-${Date.now().toString(36)}`, type: 'results', title: `Spotify · ${q}`,
        items: res.map(r => ({ title: r.title, subtitle: r.artist, thumbnail: r.thumbnail, action: { kind: 'music', url: r.embed } })),
      } as any)
      return `Showed ${res.length} Spotify tracks for "${q}" (click one to play). Top: ${res.slice(0, 3).map(r => `${r.title} — ${r.artist}`).join('; ')}.`
    } catch (e) { return `[ERROR] Spotify search failed: ${(e as Error).message}` }
  })
  add('MusicPlay', { destructive: false }, async args => {
    if (!(await getUserToken(ctx.store))) return 'Connect your Spotify account first (Settings → Apps → Connect Spotify).'
    try {
      let uri = String(args?.uri || '').trim()
      let label = ''
      if (!uri) {
        const q = String(args?.query || '').trim()
        if (!q) return 'Provide a song/artist to play.'
        const hits = await spotifySearch(q, 1)
        if (!hits.length) return `No Spotify track found for "${q}".`
        // emit the track widget for visual
        emitWidget(ctx.sessionId, { id: `sp-now`, type: 'music', title: `${hits[0].title} — ${hits[0].artist}`, url: hits[0].embed } as any)
        // derive the track uri from the embed url
        const m = hits[0].embed.match(/track\/([A-Za-z0-9]+)/); if (m) uri = `spotify:track:${m[1]}`
        label = `${hits[0].title} — ${hits[0].artist}`
      }
      const r = await spotifyApi(ctx.store, '/me/player/play', { method: 'PUT', body: JSON.stringify(uri ? { uris: [uri] } : {}) })
      if (r.status === 404) return `Showing "${label}". Open Spotify (or the orb2 player) so there's an active device, then I can start it.`
      if (!r.ok && r.status !== 204) return `Spotify play returned ${r.status}. ${label ? `Showing "${label}".` : ''}`
      return `Playing${label ? ` "${label}"` : ''} on your Spotify.`
    } catch (e) { return `[ERROR] ${(e as Error).message}` }
  })
  add('MusicControl', { destructive: false }, async args => {
    if (!(await getUserToken(ctx.store))) return 'Connect your Spotify account first (Settings → Apps → Connect Spotify).'
    const action = String(args?.action || '')
    try {
      let r: Response
      if (action === 'pause') r = await spotifyApi(ctx.store, '/me/player/pause', { method: 'PUT' })
      else if (action === 'play') r = await spotifyApi(ctx.store, '/me/player/play', { method: 'PUT' })
      else if (action === 'next') r = await spotifyApi(ctx.store, '/me/player/next', { method: 'POST' })
      else if (action === 'previous') r = await spotifyApi(ctx.store, '/me/player/previous', { method: 'POST' })
      else if (action === 'volume') r = await spotifyApi(ctx.store, `/me/player/volume?volume_percent=${Math.max(0, Math.min(100, Number(args?.volume) || 50))}`, { method: 'PUT' })
      else return `Unknown action "${action}".`
      if (r.status === 404) return 'No active Spotify device — open Spotify or the orb2 player first.'
      return `Done (${action}).`
    } catch (e) { return `[ERROR] ${(e as Error).message}` }
  })
  add('WebSearch', { readOnly: true }, async args => {
    const q = String(args?.query || '').trim()
    if (!q) return 'Provide a search query.'
    const wid = `search-${Date.now().toString(36)}`
    emitWidget(ctx.sessionId, { id: wid, type: 'results', title: `Web · ${q}`, pending: true } as any)
    try {
      const hits = await webSearch(q, Math.min(Number(args?.count) || 8, 20))
      if (!hits.length) return `No results for "${q}".`
      emitWidget(ctx.sessionId, {
        id: wid, type: 'results', title: `Web · ${q}`,
        items: hits.map(h => ({ title: h.title, subtitle: h.snippet.slice(0, 120), action: { kind: 'link', url: h.url } })),
      } as any)
      return `Top results for "${q}":\n` + hits.map((h, i) => `${i + 1}. ${h.title} — ${h.url}\n   ${h.snippet.slice(0, 200)}`).join('\n')
    } catch (e) { return `[ERROR] Web search failed: ${(e as Error).message}` }
  })
  add('NewsSearch', { readOnly: true }, async args => {
    const q = String(args?.query || '').trim()
    try {
      const res = await newsSearch(q, 8)
      if (!res.length) return `No news found${q ? ` for "${q}"` : ''}.`
      emitWidget(ctx.sessionId, {
        id: `news-${Date.now().toString(36)}`, type: 'results', title: q ? `News · ${q}` : 'Top headlines',
        items: res.map(r => ({ title: r.title, subtitle: r.source, thumbnail: r.thumbnail, action: { kind: 'link', url: r.url } })),
      } as any)
      return `Showed ${res.length} news articles${q ? ` for "${q}"` : ''}. Top: ${res.slice(0, 3).map(r => r.title).join('; ')}.`
    } catch (e) { return `[ERROR] News search failed: ${(e as Error).message}` }
  })
  add('Docker', { destructive: false }, async args => {
    const action = String(args?.action || 'list')
    try {
      if (action === 'list') {
        const cs = await dockerList(true)
        const running = cs.filter(c => c.state === 'running').length
        emitWidget(ctx.sessionId, { id: 'docker', type: 'docker', title: 'Docker', containers: cs, pill: `${running}/${cs.length} up` } as any)
        return `${cs.length} container(s), ${running} running. Shown in the Docker widget.`
      }
      const r = await dockerControl(action, args?.target ? String(args.target) : undefined, args?.image ? String(args.image) : undefined)
      if (action === 'logs') return r.message
      // refresh the widget after a state change
      const cs = await dockerList(true)
      emitWidget(ctx.sessionId, { id: 'docker', type: 'docker', title: 'Docker', containers: cs, pill: `${cs.filter(c => c.state === 'running').length}/${cs.length} up` } as any)
      return r.message
    } catch (e) { return `[ERROR] ${(e as Error).message}` }
  })
  add('Geocode', { readOnly: true }, async args => {
    const q = String(args?.query || '').trim()
    if (!q) return 'Provide a place or address.'
    try { const g = await geocode(q); return g ? `${g.name || q}: lat ${g.lat.toFixed(5)}, lng ${g.lng.toFixed(5)}` : `No location found for "${q}".` }
    catch (e) { return `[ERROR] ${(e as Error).message}` }
  })
  add('Weather', { readOnly: true }, async args => {
    let loc = String(args?.location || '').trim()
    if (!loc || /^(here|home|my (house|home|location)|current location)$/i.test(loc)) {
      loc = (await homeLocation()) || ''
    }
    if (!loc) return "No location given and no home location set — ask the user where, or set one via Settings / Home Assistant."
    try {
      const w = await weather(loc)
      if (!w) return `Couldn't find weather for "${loc}".`
      emitWidget(ctx.sessionId, { id: 'weather', type: 'weather', title: w.location, location: w.location, current: w.current, forecast: w.forecast } as any)
      return `${w.location}: ${w.current.temp}°F, ${w.current.condition}, humidity ${w.current.humidity}%, wind ${w.current.wind} mph. Shown in the weather widget.`
    } catch (e) { return `[ERROR] ${(e as Error).message}` }
  })
  add('Directions', { readOnly: true }, async args => {
    const to = String(args?.to || '').trim()
    if (!to) return 'Provide a destination (`to`).'
    const places = [
      ...(args?.from ? [String(args.from)] : []),
      ...((Array.isArray(args?.stops) ? args.stops : []) as string[]).map(String),
      to,
    ]
    try {
      const pts = [] as { lat: number; lng: number; name?: string }[]
      for (const p of places) { const g = await geocode(p); if (!g) return `Could not find "${p}".`; pts.push(g) }
      const markers = pts.map((g, i) => ({ lat: g.lat, lng: g.lng, label: places[i] }))
      let routeCoords: [number, number][] | undefined
      let summary = ''
      if (pts.length >= 2) {
        const r = await geoRoute(pts)
        if (r) { routeCoords = r.coords; summary = `~${r.distanceKm.toFixed(0)} km, ~${Math.round(r.durationMin)} min driving` }
      }
      const center: [number, number] = [pts[0]!.lat, pts[0]!.lng]
      emitWidget(ctx.sessionId, { id: 'map', type: 'map', title: pts.length >= 2 ? `${places[0]} → ${to}` : to, center, zoom: pts.length >= 2 ? 11 : 13, markers, route: routeCoords } as any)
      return `Showing the route on the map${summary ? ` (${summary})` : ''}. To add a stop, call Directions again with it in \`stops\`.`
    } catch (e) { return `[ERROR] ${(e as Error).message}` }
  })
  add('CloudStorageSearch', { readOnly: true }, async args => {
    const query = String(args?.query || '').trim()
    const provider = (args?.provider as CloudProvider | undefined)
    const connected = await connectedProviders(ctx.store)
    if (!connected.length) return 'No cloud storage is connected. Ask the user to connect Google Drive or OneDrive in Settings → Apps → Cloud Storage.'
    let files
    try { files = await searchCloud(ctx.store, query, provider, 15) } catch (e) { return `[ERROR] ${(e as Error).message}` }
    if (!files.length) return `No files found${query ? ` matching "${query}"` : ''} in ${provider || connected.join(' + ')}.`
    emitWidget(ctx.sessionId, {
      type: 'results', title: query ? `Cloud: ${query}` : 'Cloud files',
      items: files.map(f => ({
        title: f.name,
        subtitle: `${f.provider === 'google' ? 'Google Drive' : 'OneDrive'}${f.size ? ` · ${(f.size / 1024 / 1024).toFixed(1)} MB` : ''}${f.isFolder ? ' · folder' : ''}`,
        action: f.webUrl ? { kind: 'link', url: f.webUrl } : undefined,
      })),
    } as any)
    const list = files.map(f => `- [${f.provider}] ${f.name}${f.isFolder ? '/' : ''} (id: ${f.id})`).join('\n')
    return `Found ${files.length} item(s):\n${list}\n\nUse CloudStoragePull with the provider + id to bring a file into the workspace.`
  })
  add('CloudStoragePull', { destructive: false }, async args => {
    const provider = args?.provider as CloudProvider
    const fileId = String(args?.file_id || '').trim()
    if (provider !== 'google' && provider !== 'microsoft') return 'provider must be "google" or "microsoft".'
    if (!fileId) return 'Provide the file_id from CloudStorageSearch.'
    try {
      const r = await downloadCloudFile(ctx.store, provider, fileId, ctx.sessionId, args?.name ? String(args.name) : undefined)
      return `Downloaded "${r.name}" into the workspace at cloud/${r.name} (servable: ${r.url}). You can now read or display it.`
    } catch (e) { return `[ERROR] ${(e as Error).message}` }
  })
  add('Blender', { destructive: false }, async args => {
    const base = (process.env.ORB2_BLENDER_URL || 'http://blender:8996').replace(/\/+$/, '')
    const wsRoot = process.env.ORB2_API_WORKSPACE_ROOT || '/workspace'
    const { join, resolve } = await import('node:path')
    // Accept a workspace-relative path OR a bare widget id ("model-main").
    const resolveFile = (f: string): string | null => {
      const name = /^[A-Za-z0-9_-]+$/.test(f) ? `.widget/${f}.glb` : f
      const full = resolve(join(wsRoot, ctx.sessionId, name))
      return full.startsWith(resolve(wsRoot)) ? full : null
    }
    const call = async (path: string, body: any): Promise<any> => {
      const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return r.json()
    }
    const fmtDims = (d: any) => d?.dimensions_m
      ? `${d.dimensions_m.map((x: number) => (x >= 0.01 ? `${(x * 100).toFixed(1)}cm` : `${(x * 1000).toFixed(1)}mm`)).join(' × ')}`
      : ''
    try {
      const op = String(args?.op || (args?.script ? 'build' : '')).trim()
      if (op === 'analyze' || op === 'convert' || (op === 'render' && !args?.script)) {
        const file = resolveFile(String(args?.file || '').trim())
        if (!file) return "Which file? Give a workspace path or a model widget id (e.g. file:'model-main')."
        if (op === 'analyze') {
          const d = await call('/analyze', { in: file })
          if (!d.ok) return `[ERROR] analyze failed: ${String(d.error || d.stderr || '').slice(-400)}`
          return `Mesh: ${d.objects} object(s), ${d.triangles.toLocaleString()} triangles. Size: ${fmtDims(d)}. Volume: ${d.volume_l} L. ${d.watertight ? 'Watertight — ready to 3D print.' : 'NOT watertight — a printer/slicer may reject it; the mesh has open edges.'}`
        }
        if (op === 'convert') {
          const format = String(args?.format || 'stl').toLowerCase()
          const outName = `${file.split('/').pop()!.replace(/\.[^.]+$/, '')}.${format}`
          const out = join(wsRoot, ctx.sessionId, outName)
          const d = await call('/convert', { in: file, out })
          if (!d.ok) return `[ERROR] convert failed: ${String(d.error || d.stderr || '').slice(-400)}`
          return `Converted → ${outName}. Download: /v1/workspace/${ctx.sessionId}/${outName}${format === 'stl' ? ' — ready for the slicer.' : ''}`
        }
        // render from file
        const out = join(wsRoot, ctx.sessionId, '.widget', 'render.png')
        const d = await call('/render', { in: file, out })
        if (!d.ok) return `[ERROR] render failed: ${String(d.error || d.stderr || '').slice(-400)}`
        emitWidget(ctx.sessionId, { id: 'render', type: 'image', title: args?.title || 'Render', url: `/v1/workspace/${ctx.sessionId}/.widget/render.png?t=${Date.now()}` } as any)
        return 'Rendered a studio still of the model.'
      }

      const script = String(args?.script || '').trim()
      if (!script) return "Provide a bpy script (op:'build'/'render'), or a file for convert/analyze."
      if (op === 'render') {
        emitWidget(ctx.sessionId, { id: 'render', type: 'image', title: args?.title || 'Render', pending: true } as any)
        const out = join(wsRoot, ctx.sessionId, '.widget', 'render.png')
        const d = await call('/render', { script, out })
        if (!d.ok) return `[ERROR] render failed: ${String(d.error || d.stderr || '').slice(-400)}`
        emitWidget(ctx.sessionId, { id: 'render', type: 'image', title: args?.title || 'Render', url: `/v1/workspace/${ctx.sessionId}/.widget/render.png?t=${Date.now()}` } as any)
        return 'Rendered a studio still.'
      }
      // build (default)
      const id = (typeof args?.id === 'string' && args.id.trim()) ? args.id.trim() : 'model-main'
      emitWidget(ctx.sessionId, { id, type: 'model', title: args?.title || '3D model', pending: true } as any)
      const out = `${wsRoot}/${ctx.sessionId}/.widget/${id}.glb`
      const d = await call('/run', { script, out })
      if (!d.ok) return `[ERROR] Blender failed: ${String(d.stderr || d.error || 'unknown').slice(-700)}`
      // Real dimensions ride along on the widget and in the reply.
      const a = await call('/analyze', { in: out }).catch(() => null)
      emitWidget(ctx.sessionId, {
        id, type: 'model', title: args?.title || '3D model',
        url: `/v1/workspace/${ctx.sessionId}/.widget/${id}.glb?t=${Date.now()}`,
        dims: a?.ok ? fmtDims(a) : undefined, watertight: a?.ok ? a.watertight : undefined,
      } as any)
      return `Rendered the 3D model (id: ${id}${a?.ok ? `, ${fmtDims(a)}${a.watertight ? '' : ', not watertight'}` : ''}). Iterate with the same id; op:'convert' format:'stl' makes it printable; op:'render' makes a beauty shot.`
    } catch (e) { return `[ERROR] ${(e as Error).message}` }
  })
  add('Publish', { destructive: false }, async args => {
    try {
      const { mkdir, readdir, copyFile, stat } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const wsRoot = process.env.ORB2_API_WORKSPACE_ROOT || '/workspace'
      const src = join(wsRoot, ctx.sessionId, '.canvas')
      let entries: string[]
      try { entries = await readdir(src) } catch { return '[ERROR] Nothing to publish — build the page with the Canvas tool first, then call Publish.' }
      if (!entries.length) return '[ERROR] The canvas is empty — build it first.'
      // Prefer Vercel (truly public, off-box) when connected.
      if (vercelEnabled()) {
        const { readFile } = await import('node:fs/promises')
        const files: { path: string; content: Buffer }[] = []
        const walk = async (dir: string, rel: string): Promise<void> => {
          for (const e of await readdir(dir)) {
            const sp = join(dir, e); const rp = rel ? `${rel}/${e}` : e
            const st = await stat(sp)
            if (st.isDirectory()) await walk(sp, rp)
            else files.push({ path: rp, content: await readFile(sp) })
          }
        }
        await walk(src, '')
        try {
          const url = await deployToVercel(files, `orb2-${args?.title || 'share'}`)
          return `Published to Vercel (public, no login): ${url}`
        } catch (e) { /* fall back to internal publish below */ void e }
      }
      const id = Math.random().toString(36).slice(2, 10)
      const dst = join(wsRoot, '.published', id)
      const cp = async (s: string, d: string): Promise<void> => {
        await mkdir(d, { recursive: true })
        for (const e of await readdir(s)) {
          const sp = join(s, e), dp = join(d, e)
          const st = await stat(sp)
          if (st.isDirectory()) await cp(sp, dp); else await copyFile(sp, dp)
        }
      }
      await cp(src, dst)
      await ctx.store.putKv(`published:${id}`, JSON.stringify({ title: args?.title || 'orb2', created: Date.now() }), 60 * 60 * 24 * 365).catch(() => {})
      const base = (process.env.ORB2_PUBLIC_URL || '').replace(/\/+$/, '')
      const url = `${base}/pub/${id}/`
      return `Published! Public link (no login required): ${url} — share it with anyone.`
    } catch (e) { return `[ERROR] publish failed: ${(e as Error).message}` }
  })
  add('RecallMemory', { readOnly: true }, args => executeRecall(args, { store: ctx.store }))
  add('Vision', { readOnly: true }, args => executeVision(args, { store: ctx.store, ownerId: ctx.ownerId }))
  add('ClusterOps', {}, args => executeClusterOps(args))
  add('DockerOps', {}, args => executeDockerOps(args))
  add('SelfEvolve', { destructive: true }, args => executeSelfEvolve(args))
  add('SelfUpdate', { destructive: true }, args => executeSelfUpdate(args))
  add('SelfBuild', { destructive: true }, args => executeSelfBuild(args))
  add('SubmitJob', {}, async args => {
    const r = await executeSubmitJob(args, { sessionId: ctx.sessionId, ownerId: ctx.ownerId, store: ctx.store })
    return r.message
  })
  add('RunCode', {}, async args => {
    const r = await executeRunCode({ language: args.language || 'python3', code: args.code, stdin: args.stdin })
    return JSON.stringify(r)
  })
  add('VaultRead', { readOnly: true }, async args => JSON.stringify(await executeVaultRead(args, ctx.store)))
  add('VaultWrite', {}, async args => JSON.stringify(await executeVaultWrite(args, ctx.store, ctx.sessionId)))
  add('VaultSearch', { readOnly: true }, async args => JSON.stringify(await executeVaultSearch(args, ctx.store)))

  add('Concierge', { readOnly: true }, async args => {
    const query = String(args?.query || '').trim()
    if (!query) return 'What are you looking to buy?'
    const mode = String(args?.mode || 'both')
    const parts: string[] = []

    // Online options — always cheap + useful.
    if (mode !== 'local') {
      const online = onlineOptions(query)
      emitWidget(ctx.sessionId, {
        id: 'shop-online', type: 'results', title: `Buy "${query}" online`,
        items: online.map(o => ({ title: o.merchant, subtitle: 'Search & order online', action: { kind: 'link', url: o.url } })),
      } as any)
      parts.push(`Online: ${online.map(o => o.merchant).join(', ')} (shown with links).`)
    }

    // Local stores — needs a location.
    if (mode !== 'online') {
      const place = String(args?.near || (await homeLocation()) || '').trim()
      if (!place) {
        parts.push("For nearby stores, tell me roughly where you are (or set a home location).")
      } else {
        const geo = await geocode(place)
        if (!geo) {
          parts.push(`Couldn't locate "${place}" for nearby stores.`)
        } else {
          const stores = await nearbyStores(query, geo.lat, geo.lng)
          if (!stores.length) {
            parts.push(`No nearby stores found around ${place} for that — online is your best bet.`)
          } else {
            emitWidget(ctx.sessionId, {
              id: 'shop-map', type: 'map', title: `Stores near ${place}`,
              center: [geo.lat, geo.lng], zoom: 13,
              markers: stores.map(s => ({ lat: s.lat, lng: s.lng, label: `${s.name} · ${s.distanceKm}km` })),
            } as any)
            const top = stores.slice(0, 5).map(s => `${s.name} (${s.distanceKm}km)`).join(', ')
            parts.push(`Nearby: ${top}. ${stores.length} on the map — ask for directions to any of them.`)
          }
        }
      }
    }
    return parts.join(' ')
  })

  add('Home', {}, async args => {
    try {
      const op = String(args?.op || 'list')

      if (op === 'list') {
        const domains = args?.type ? [String(args.type)] : HOME_DOMAINS
        const all = await haJoinAreas(await haStates(domains))
        if (!all.length) return 'No matching devices found in Home Assistant.'
        const byDomain = new Map<string, HaEntity[]>()
        for (const e of all) (byDomain.get(e.domain) ?? byDomain.set(e.domain, []).get(e.domain)!).push(e)
        emitWidget(ctx.sessionId, {
          id: 'home', type: 'home', title: 'Home', pill: `${all.length} devices`,
          devices: all.map(toDeviceCard),
        } as any)
        const summary = [...byDomain.entries()]
          .map(([d, es]) => `${prettyDomain(d)} (${es.length}): ${es.slice(0, 4).map(e => e.name).join(', ')}${es.length > 4 ? '…' : ''}`)
          .join(' · ')
        return `Showed ${all.length} devices on the Home dashboard. ${summary}`
      }

      if (op === 'lights') {
        const all = await haJoinAreas(await haStates(['light']))
        if (!all.length) return 'No lights found in Home Assistant.'
        const groups = new Map<string, any[]>()
        for (const e of all) {
          const area = e.area || 'Other'
          ;(groups.get(area) ?? groups.set(area, []).get(area)!).push({
            entity_id: e.entity_id, name: e.name, on: e.state === 'on',
            brightness: e.attributes.brightness != null ? Math.round((e.attributes.brightness / 255) * 100) : undefined,
          })
        }
        emitWidget(ctx.sessionId, {
          id: 'lights', type: 'lights', title: 'Lights', pill: `${all.filter(e => e.state === 'on').length}/${all.length} on`,
          groups: [...groups.entries()].map(([area, lights]) => ({ area, lights })),
        } as any)
        return `Showed the lights widget — ${all.length} light(s) in ${groups.size} room(s), ${all.filter(e => e.state === 'on').length} on.`
      }
      if (op === 'media') {
        const q = String(args?.query || '').trim()
        let players = await haJoinAreas(await haStates(['media_player']))
        if (q) players = haResolve(players, q, 'media_player')
        if (!players.length) return 'No media players found.'
        for (const e of players.slice(0, 4)) {
          const pic = e.attributes.entity_picture
          // Say WHAT the device is: a Sonos named "Living Room" and a TV in
          // the Living Room area are indistinguishable by name alone.
          const dc = String(e.attributes.device_class || '').toLowerCase()
          const kind = dc === 'tv' || /\btv\b/i.test(e.name) ? 'TV' : dc === 'receiver' ? 'receiver' : 'speaker'
          const title = e.area && e.name.toLowerCase() === String(e.area).toLowerCase() ? `${e.name} ${kind}` : e.name
          emitWidget(ctx.sessionId, {
            id: `media-${e.entity_id}`, type: 'media', title,
            entity_id: e.entity_id, name: e.name, kind, area: e.area, state: e.state,
            media_title: e.attributes.media_title, app: e.attributes.app_name,
            volume: e.attributes.volume_level != null ? Math.round(e.attributes.volume_level * 100) : undefined,
            artwork: pic ? `/v1/home/ha-image?path=${encodeURIComponent(pic)}` : undefined,
          } as any)
        }
        return `Showed media remote${players.length > 1 ? 's' : ''} for: ${players.slice(0, 4).map(p => p.name).join(', ')}.`
      }
      if (op === 'vacuum') {
        const vs = await haJoinAreas(await haStates(['vacuum']))
        if (!vs.length) return "No vacuum in Home Assistant yet. A Roomba can be added: HomeAdmin op:'setup' integration:'roomba' (it will ask for host/blid/password)."
        for (const e of vs.slice(0, 3)) emitWidget(ctx.sessionId, {
          id: `vacuum-${e.entity_id}`, type: 'vacuum', title: e.name,
          entity_id: e.entity_id, name: e.name, area: e.area, state: e.state,
          battery: e.attributes.battery_level, fan: e.attributes.fan_speed,
        } as any)
        return `Showed vacuum widget: ${vs.map(v => `${v.name} (${v.state}${v.attributes.battery_level != null ? `, ${v.attributes.battery_level}%` : ''})`).join(', ')}.`
      }
      if (op === 'covers') {
        const cs = await haJoinAreas(await haStates(['cover']))
        if (!cs.length) return 'No shades/blinds/covers in Home Assistant.'
        const groups = new Map<string, any[]>()
        for (const e of cs) {
          const area = e.area || 'Other'
          const arr = groups.get(area) ?? []
          arr.push({ entity_id: e.entity_id, name: e.name, state: e.state, position: e.attributes.current_position })
          groups.set(area, arr)
        }
        emitWidget(ctx.sessionId, { id: 'covers', type: 'covers', title: 'Shades',
          groups: [...groups.entries()].map(([area, covers]) => ({ area, covers })) } as any)
        return `Showed the shades widget — ${cs.length} cover(s).`
      }
      if (op === 'security') {
        const [locks, bins] = await Promise.all([
          haJoinAreas(await haStates(['lock'])),
          haJoinAreas(await haStates(['binary_sensor'])),
        ])
        const KINDS: Record<string, string> = { door: 'door', garage_door: 'door', window: 'window', opening: 'door', motion: 'motion', occupancy: 'motion', presence: 'motion', smoke: 'smoke', carbon_monoxide: 'co' }
        const sensors = bins
          .map(e => ({ entity_id: e.entity_id, name: e.name, area: e.area, kind: KINDS[e.attributes.device_class] , on: e.state === 'on' }))
          .filter(s => s.kind)
        if (!locks.length && !sensors.length) return 'No locks or door/window/motion sensors in Home Assistant.'
        emitWidget(ctx.sessionId, { id: 'security', type: 'security', title: 'Security',
          pill: `${locks.filter(l => l.state !== 'locked').length + sensors.filter(s => s.on && s.kind !== 'motion').length} open`,
          locks: locks.map(l => ({ entity_id: l.entity_id, name: l.name, area: l.area, locked: l.state === 'locked' })),
          sensors } as any)
        const open = sensors.filter(s => s.on && s.kind !== 'motion').map(s => s.name)
        return `Showed the security widget: ${locks.length} lock(s), ${sensors.length} sensor(s).${open.length ? ` OPEN right now: ${open.join(', ')}.` : ''}`
      }
      if (op === 'plugs') {
        const ps = await haJoinAreas(await haStates(['switch']))
        if (!ps.length) return 'No plugs/switches in Home Assistant.'
        const groups = new Map<string, any[]>()
        for (const e of ps) {
          const area = e.area || 'Other'
          const arr = groups.get(area) ?? []
          arr.push({ entity_id: e.entity_id, name: e.name, on: e.state === 'on' })
          groups.set(area, arr)
        }
        emitWidget(ctx.sessionId, { id: 'plugs', type: 'plugs', title: 'Plugs & switches',
          pill: `${ps.filter(e => e.state === 'on').length}/${ps.length} on`,
          groups: [...groups.entries()].map(([area, plugs]) => ({ area, plugs })) } as any)
        return `Showed the plugs widget — ${ps.length} switch(es).`
      }
      if (op === 'scenes') {
        const sc = await haJoinAreas(await haStates(['scene']))
        if (!sc.length) return 'No scenes defined in Home Assistant.'
        emitWidget(ctx.sessionId, { id: 'scenes', type: 'scenes', title: 'Scenes',
          scenes: sc.map(s => ({ entity_id: s.entity_id, name: s.name, area: s.area })) } as any)
        return `Showed the scenes widget: ${sc.map(s => s.name).join(', ')}.`
      }
      if (op === 'sensors') {
        const ss = await haJoinAreas(await haStates(['sensor']))
        const KEEP = new Set(['temperature', 'humidity', 'battery', 'illuminance', 'power', 'energy', 'pm25', 'co2', 'pressure'])
        const readings = ss
          .filter(e => KEEP.has(e.attributes.device_class) && e.state !== 'unavailable' && e.state !== 'unknown')
          .map(e => ({ entity_id: e.entity_id, name: e.name, area: e.area, kind: e.attributes.device_class, value: e.state, unit: e.attributes.unit_of_measurement || '' }))
        if (!readings.length) return 'No environmental sensors (temperature/humidity/battery/energy…) found.'
        const groups = new Map<string, any[]>()
        for (const r of readings) {
          const arr = groups.get(r.area || 'Other') ?? []
          arr.push(r)
          groups.set(r.area || 'Other', arr)
        }
        emitWidget(ctx.sessionId, { id: 'sensors', type: 'sensors', title: 'Readings',
          groups: [...groups.entries()].map(([area, readings]) => ({ area, readings })) } as any)
        return `Showed the readings widget — ${readings.length} sensor(s).`
      }
      if (op === 'camera') {
        const cams = await haJoinAreas(await haStates(['camera']))
        if (!cams.length) return 'No cameras in Home Assistant.'
        for (const c of cams.slice(0, 4)) emitWidget(ctx.sessionId, {
          id: `camera-${c.entity_id}`, type: 'camera', title: c.name,
          entity_id: c.entity_id, name: c.name, area: c.area,
          snapshot: `/v1/home/ha-image?path=${encodeURIComponent(`/api/camera_proxy/${c.entity_id}`)}`,
        } as any)
        return `Showed camera widget${cams.length > 1 ? 's' : ''}: ${cams.slice(0, 4).map(c => c.name).join(', ')}.`
      }
      if (op === 'printer') {
        // 3D printers (Bambu Lab via the bambu_lab integration; the shape
        // generalizes to other printer integrations exposing the same kinds
        // of entities). Group that platform's entities by physical device.
        const [states, reg] = await Promise.all([haStates(), haEntityRegistry()])
        const regById = new Map(reg.map(r => [r.entity_id, r] as const))
        const printers = new Map<string, HaEntity[]>()
        for (const e of states) {
          const r = regById.get(e.entity_id)
          if (r?.platform !== 'bambu_lab' || !r.device_id) continue
          const arr = printers.get(r.device_id) ?? []
          arr.push(e)
          printers.set(r.device_id, arr)
        }
        if (!printers.size) return "No 3D printer paired yet. The bambu_lab integration is installed — say 'set up the bambu printer' (the flow asks for the printer's IP / serial / LAN access code from its screen)."
        const pick = (es: HaEntity[], dom: string, suffix: RegExp) => es.find(e => e.domain === dom && suffix.test(e.entity_id))
        for (const [devId, es] of [...printers.entries()].slice(0, 2)) {
          const stage = pick(es, 'sensor', /(current_stage|print_status|stage)$/)
          const progress = pick(es, 'sensor', /(print_progress|progress)$/)
          const layer = pick(es, 'sensor', /current_layer$/)
          const layers = pick(es, 'sensor', /total_layer_count$/)
          const remaining = pick(es, 'sensor', /remaining_time$/)
          const nozzle = pick(es, 'sensor', /nozzle_temperature$/)
          const nozzleT = pick(es, 'sensor', /nozzle_target_temperature$/)
          const bed = pick(es, 'sensor', /bed_temperature$/)
          const bedT = pick(es, 'sensor', /(bed_target_temperature|target_bed_temperature)$/)
          const cam = es.find(e => e.domain === 'camera')
          const name = (cam?.name || es[0]!.name).replace(/ (camera|chamber.*)$/i, '')
          emitWidget(ctx.sessionId, {
            id: `printer3d-${devId}`, type: 'printer3d', title: name,
            name, state: stage?.state || 'unknown',
            progress: progress ? Number(progress.state) : undefined,
            layer: layer ? Number(layer.state) : undefined,
            total_layers: layers ? Number(layers.state) : undefined,
            remaining_min: remaining ? Number(remaining.state) : undefined,
            nozzle: nozzle ? Number(nozzle.state) : undefined,
            nozzle_target: nozzleT ? Number(nozzleT.state) : undefined,
            bed: bed ? Number(bed.state) : undefined,
            bed_target: bedT ? Number(bedT.state) : undefined,
            stream: cam ? `/v1/home/ha-image?path=${encodeURIComponent(`/api/camera_proxy_stream/${cam.entity_id}`)}` : undefined,
            snapshot: cam ? `/v1/home/ha-image?path=${encodeURIComponent(`/api/camera_proxy/${cam.entity_id}`)}` : undefined,
            controls: {
              pause: pick(es, 'button', /pause$/)?.entity_id,
              resume: pick(es, 'button', /resume$/)?.entity_id,
              stop: pick(es, 'button', /stop$/)?.entity_id,
            },
          } as any)
        }
        const first = [...printers.values()][0]!
        const st = pick(first, 'sensor', /(current_stage|print_status|stage)$/)
        const pg = pick(first, 'sensor', /(print_progress|progress)$/)
        return `Showed the printer widget${printers.size > 1 ? 's' : ''}. Status: ${st?.state || 'unknown'}${pg ? `, ${pg.state}%` : ''}.`
      }
      if (op === 'mode') {
        const { getMode, setMode } = await import('../home/mode.js')
        const want = String(args?.mode || '').toLowerCase()
        const emitMode = (m: string) => emitWidget(ctx.sessionId, { id: 'housemode', type: 'housemode', title: 'House mode', mode: m } as any)
        if (!['home', 'away', 'vacation', 'guest'].includes(want)) {
          const cur = await getMode(ctx.store)
          emitMode(cur)
          return `House mode is "${cur}" (widget shown). Set with mode:'home'|'away'|'vacation'|'guest'.`
        }
        await setMode(ctx.store, want as any)
        emitMode(want)
        const did: string[] = []
        if (args?.secure === true && (want === 'away' || want === 'vacation')) {
          const [locks, lights] = await Promise.all([haStates(['lock']), haStates(['light'])])
          for (const l of locks.filter(x => x.state !== 'locked')) { await haCallService('lock', 'lock', l.entity_id); did.push(`locked ${l.name}`) }
          for (const li of lights.filter(x => x.state === 'on')) { await haCallService('light', 'turn_off', li.entity_id); did.push(`${li.name} off`) }
        }
        const postures: Record<string, string> = {
          home: 'normal watch — gentle nudges',
          away: 'ARMED — instant alerts on any door, window or motion',
          vacation: 'ARMED — instant alerts + I will keep an eye out daily',
          guest: 'relaxed — door nudges muted while you have visitors',
        }
        return `House mode → ${want} (${postures[want]}).${did.length ? ` Secured: ${did.join(', ')}.` : ''}`
      }
      if (op === 'presence') {
        // Merged: the phones' geofence reports first, HA persons fill gaps.
        const { listPresence } = await import('../presence/presence.js')
        const people = (await listPresence(ctx.store)).map(p => ({
          name: p.name, home: p.home, state: p.home ? 'home' : 'away', source: p.source,
        }))
        if (!people.length) return 'No presence yet — the phone apps report it automatically (Settings → Report presence), or configure People in Home Assistant.'
        emitWidget(ctx.sessionId, { id: 'presence', type: 'presence', title: "Who's home",
          pill: `${people.filter(p => p.home).length}/${people.length} home`, people } as any)
        return `Presence: ${people.map(p => `${p.name} is ${p.home ? 'home' : 'away'}`).join(' · ')}.`
      }
      if (op === 'automations') {
        const autos = (await haStates(['automation'])).map(a => ({
          entity_id: a.entity_id, name: a.name, on: a.state === 'on',
          last: a.attributes.last_triggered || null,
        }))
        if (!autos.length) return "No automations yet. I can create one — describe it (e.g. 'every night at 10, lock the doors') and I'll use HomeAdmin op:'automate'."
        emitWidget(ctx.sessionId, { id: 'automations', type: 'automations', title: 'Automations',
          pill: `${autos.filter(a => a.on).length}/${autos.length} on`, automations: autos } as any)
        return `Automations: ${autos.map(a => `${a.name} (${a.on ? 'on' : 'off'})`).join(' · ')}.`
      }
      if (op === 'climate') {
        const cl = await haJoinAreas(await haStates(['climate']))
        if (!cl.length) return 'No thermostats found.'
        for (const e of cl.slice(0, 4)) emitWidget(ctx.sessionId, {
          id: `climate-${e.entity_id}`, type: 'climate', title: e.name,
          entity_id: e.entity_id, name: e.name, area: e.area, state: e.state,
          current: e.attributes.current_temperature, target: e.attributes.temperature,
        } as any)
        return `Showed thermostat${cl.length > 1 ? 's' : ''}: ${cl.slice(0, 4).map(c => `${c.name} (now ${c.attributes.current_temperature ?? '?'}°, set ${c.attributes.temperature ?? '?'}°)`).join(', ')}.`
      }

      const query = String(args?.query || '').trim()
      if (!query) return "Tell me which device — e.g. 'kitchen lights' or 'front door'."
      const entities = await haStates(HOME_DOMAINS)
      const matches = haResolve(entities, query, args?.type)
      if (!matches.length) return `No device matching "${query}". Try Home op:list to see names.`
      const target = matches[0]!

      if (op === 'status') {
        const extra = describeAttrs(target)
        emitWidget(ctx.sessionId, {
          id: 'home-device', type: 'stats', title: target.name,
          stats: [{ label: prettyDomain(target.domain), value: target.state, sub: extra || undefined }],
        } as any)
        return `${target.name} is ${target.state}${extra ? ` (${extra})` : ''}.`
      }

      // op === 'control'
      const action = String(args?.action || '').toLowerCase()
      if (!action) return `What should I do with ${target.name}? (on/off, lock/unlock, open/close, set…)`
      const value = typeof args?.value === 'number' ? args.value : undefined
      const plan = planControl(target, action, value)
      if (!plan) return `Can't ${action} ${target.name} (a ${prettyDomain(target.domain)}). Try a different action.`
      await haCallService(plan.domain, plan.service, target.entity_id, plan.data)
      return `Done — ${plan.confirm(target.name)}.`
    } catch (e) {
      return `[Home Assistant] ${(e as Error).message}`
    }
  })
  add('HomeAdmin', {}, async args => {
    try {
      const op = String(args?.op || '')
      if (op === 'areas') {
        const [areas, byEntity] = await Promise.all([haAreas(), haAreaByEntity()])
        if (!areas.length) return 'No areas defined yet. Create rooms with op:create_area.'
        const counts = new Map<string, number>()
        for (const name of byEntity.values()) counts.set(name, (counts.get(name) ?? 0) + 1)
        return 'Areas: ' + areas.map(a => `${a.name} (${counts.get(a.name) ?? 0} devices)`).join(' · ')
      }
      if (op === 'create_area') {
        const name = String(args?.name || args?.area || '').trim()
        if (!name) return 'Give the room a name.'
        const a = await haCreateArea(name)
        return `Created area "${a.name}".`
      }
      if (op === 'suggest') {
        const { haPatternDigest } = await import('../connectors/homeAssistant.js')
        const digest = await haPatternDigest(7)
        const existing = (await haStates(['automation'])).map(a => a.name).join(', ') || 'none'
        return `Usage patterns (7 days):\n${digest}\nExisting automations: ${existing}.\nPropose 2-3 concrete, genuinely useful automations from these patterns (times, devices), ask the user which they want, then create the approved ones with op:'automate'. Do NOT create anything without explicit agreement.`
      }
      if (op === 'dismiss') {
        const handler = String(args?.integration || '').trim().toLowerCase()
        if (!handler) return 'Which discovered integration should I dismiss?'
        const flows = await haDiscoveredFlows()
        const targets = flows.filter(f => f.handler === handler)
        if (!targets.length) return `Nothing from "${handler}" in the discovery queue.`
        const { haFlowDismiss } = await import('../connectors/homeAssistant.js')
        for (const f of targets) await haFlowDismiss(f.flow_id)
        return `Dismissed ${targets.length} "${handler}" discovery suggestion(s). HA will re-offer it if the device reappears.`
      }
      if (op === 'automate') {
        const alias = String(args?.alias || '').trim()
        const triggers = args?.triggers
        const actions = args?.actions
        if (!alias || !Array.isArray(triggers) || !triggers.length || !Array.isArray(actions) || !actions.length) {
          return "op:'automate' needs {alias, triggers:[...], actions:[...]} (HA automation schema; optional conditions:[...])."
        }
        const autoId = alias.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || `orb_${Date.now().toString(36)}`
        const body: Record<string, any> = { alias, triggers, actions, mode: 'single' }
        if (Array.isArray(args?.conditions) && args.conditions.length) body.conditions = args.conditions
        const { haCreateAutomation } = await import('../connectors/homeAssistant.js')
        await haCreateAutomation(autoId, body)
        return `Created automation "${alias}" (id ${autoId}) and enabled it. Show it with Home op:'automations'; it can be turned off there any time.`
      }
      if (op === 'cleanup') {
        // A physical device paired through several integrations (Sonos also
        // seen by Cast/DLNA, a TV by Cast + its native integration) shows up
        // as duplicate entities. Keep the native one, hide the generic ones.
        const [states, reg] = await Promise.all([haStates(), haEntityRegistry()])
        const regById = new Map(reg.map(r => [r.entity_id, r] as const))
        const norm = (s: string) => s.toLowerCase().replace(/\[.*?\]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
        const GENERIC: Record<string, number> = { cast: 1, dlna_dmr: 0, upnp: 0 }
        type Dupe = { e: HaEntity; platform: string }
        const groups = new Map<string, Dupe[]>()
        for (const e of states.filter(x => ['media_player', 'camera'].includes(x.domain))) {
          const r = regById.get(e.entity_id)
          if (r?.hidden_by) continue
          const k = `${e.domain}:${norm(e.name)}`
          const arr = groups.get(k) ?? []
          arr.push({ e, platform: r?.platform ?? '' })
          groups.set(k, arr)
        }
        const hid: string[] = []
        for (const [, g] of groups) {
          if (g.length < 2) continue
          g.sort((a, b) => (GENERIC[b.platform] ?? 10) - (GENERIC[a.platform] ?? 10))
          for (const dupe of g.slice(1)) {
            await haUpdateEntity(dupe.e.entity_id, { hidden: true })
            hid.push(`${dupe.e.name} (${dupe.platform || 'unknown'})`)
          }
        }
        const plumbing = reg.filter(r => r.entity_category && !r.hidden_by).length
        return `Cleanup done. ${hid.length ? `Hid duplicate entities: ${hid.join(', ')} — the native integration's entity stays.` : 'No cross-integration duplicates found.'} ${plumbing} config/diagnostic accessory entities are auto-excluded from Orb's dashboards (still visible inside Home Assistant). Undo any hide with op:'hide' {query, hidden:false}.`
      }
      if (op === 'integrations') {
        const [entries, flows] = await Promise.all([haConfigEntries(), haDiscoveredFlows()])
        const bad = entries.filter(e => e.state !== 'loaded')
        let out = 'Installed: ' + entries.map(e => `${e.title} (${e.domain}${e.state !== 'loaded' ? ` — ${e.state}` : ''})`).join(' · ')
        if (flows.length) {
          // Direct-first: don't push HA pairing for devices the bridge already serves.
          const COVERED = new Set(['ipp', 'brother', 'apple_tv'])
          const needSetup = flows.filter(f => !COVERED.has(f.handler))
          const covered = flows.filter(f => COVERED.has(f.handler))
          if (needSetup.length) out += `\nDISCOVERED, awaiting setup: ${needSetup.map(f => f.handler).join(', ')} — use op:'pair' {integration:'<handler>'} to set one up.`
          if (covered.length) out += `\nAlready usable directly (AirPlay/Print tools, no HA setup needed): ${covered.map(f => f.handler).join(', ')} — pair in HA only if the user wants deep control (ink levels, queues).`
        }
        if (bad.length) out += `\nProblems: ${bad.map(e => `${e.domain} is ${e.state}`).join('; ')}.`
        return out
      }
      if (op === 'pair' || op === 'setup') {
        const handler = String(args?.integration || '').trim().toLowerCase()
        if (!handler) return "Which integration? e.g. integration:'webostv' or 'roomba'."
        let flow: any = null
        if (op === 'pair') {
          const flows = await haDiscoveredFlows()
          flow = flows.find(f => f.handler === handler)
        }
        const fields = (args?.fields && typeof args.fields === 'object') ? args.fields : {}
        let result: any
        if (flow) result = await haFlowAdvance(flow.flow_id, fields)
        else {
          result = await haFlowStart(handler)
          if (result?.flow_id && Object.keys(fields).length) result = await haFlowAdvance(result.flow_id, fields)
        }
        // Every flow state also renders as a setup widget — the user sees the
        // form (or the success/abort state) on screen, not just chat prose.
        const view = normalizeFlowResult(result); view.handler ||= handler
        emitWidget(ctx.sessionId, {
          id: `setup-${handler}`, type: 'setup',
          title: `Set up ${handler}`, integration: handler, flow: await translateFlowView(view),
        } as any)
        if (result?.type === 'create_entry') return `Done — ${handler} is set up ("${result.title || handler}"). Its devices will appear shortly. A setup card on screen confirms it.`
        if (result?.type === 'abort') return `${handler} setup aborted: ${result.reason || 'unknown'}. ${result.reason === 'already_configured' ? 'It is already set up.' : ''}`
        if (result?.type === 'form') {
          const errs = result.errors && Object.keys(result.errors).length ? ` Errors: ${JSON.stringify(result.errors)}.` : ''
          // Describe each field the flow asks for — type, required, and any
          // dropdown options — so the agent can collect answers accurately.
          const asks = (result.data_schema || []).map((f: any) => {
            if (!f?.name) return ''
            const bits: string[] = []
            if (f.required) bits.push('required')
            if (f.type) bits.push(String(f.type))
            const sel = f.selector && typeof f.selector === 'object' ? f.selector : null
            const opts = sel?.select?.options
            if (Array.isArray(opts)) bits.push(`options: ${opts.map((o: any) => typeof o === 'object' ? o.value : o).slice(0, 12).join('|')}`)
            return `${f.name}${bits.length ? ` (${bits.join(', ')})` : ''}`
          }).filter(Boolean)
          const hint = handler === 'webostv' && errs.includes('error_pairing')
            ? ' The TV must be ON and reachable; when it shows the pairing prompt the user must ACCEPT it on screen with the remote, then run pair again.'
            : ''
          const desc = result.description_placeholders && Object.keys(result.description_placeholders).length
            ? ` Context: ${JSON.stringify(result.description_placeholders).slice(0, 200)}.` : ''
          return `${handler} setup is at step "${result.step_id}".${asks.length ? ` It needs: ${asks.join('; ')} — pass answers via fields:{...}.` : ' Advance again to confirm, or check the device.'}${errs}${desc}${hint}`
        }
        return `Flow state: ${JSON.stringify(result).slice(0, 200)}`
      }
      if (op === 'diagnose') {
        const q = String(args?.query || '').trim()
        if (!q) return 'Which device should I diagnose?'
        const entities = await haStates()
        const m = haResolve(entities, q)
        if (!m.length) return `No entity matching "${q}". It may not be set up — check op:'integrations' for discovered devices.`
        const t = m[0]!
        const entries = await haConfigEntries().catch(() => [])
        const guessDomain = t.entity_id.includes('webos') || (t.attributes.friendly_name || '').toLowerCase().includes('webos') ? 'webostv' : undefined
        const entry = entries.find(e => guessDomain ? e.domain === guessDomain : (t.attributes.attribution || '').toLowerCase().includes(e.domain))
        let out = `${t.name} (${t.entity_id}): state "${t.state}".`
        if (t.state === 'unavailable') out += ' UNAVAILABLE means HA cannot reach it — usually powered off, network changed, or the integration lost auth.'
        if (entry) out += ` Integration: ${entry.domain} (${entry.state}).`
        else if (guessDomain) out += ` No ${guessDomain} integration is configured — this entity likely comes from Google Cast, which gives only limited control. Set up the real integration with op:'pair'.`
        return out
      }

      // Remaining ops act on one device resolved by name. Resolve against
      // the CLEAN set first (config/diagnostic accessories excluded) so
      // "living room tv" hits the TV, not its hidden autoplay switch; only
      // op:'hide' may need to reach raw/hidden entities.
      const query = String(args?.query || '').trim()
      if (!query) return "Tell me which device — e.g. 'living room tv'."
      const clean = await haJoinAreas(await haStates(HOME_DOMAINS))
      let matches = haResolve(clean, query)
      if (!matches.length && op === 'hide') matches = haResolve(await haStates(HOME_DOMAINS), query)
      if (!matches.length) return `No device matching "${query}".`
      const target = matches[0]!
      if (op === 'rename') {
        const name = String(args?.name || '').trim()
        if (!name) return 'Give it a new name.'
        await haUpdateEntity(target.entity_id, { name })
        return `Renamed "${target.name}" → "${name}".`
      }
      if (op === 'assign') {
        const areaName = String(args?.area || '').trim()
        if (!areaName) return 'Which room? Pass `area`.'
        const areas = await haAreas()
        let area = areas.find(a => a.name.toLowerCase() === areaName.toLowerCase())
        if (!area) area = await haCreateArea(areaName)
        await haUpdateEntity(target.entity_id, { area_id: area.area_id })
        return `Put "${target.name}" in ${area.name}.`
      }
      if (op === 'hide') {
        const hidden = args?.hidden !== false
        await haUpdateEntity(target.entity_id, { hidden })
        return `${hidden ? 'Hid' : 'Unhid'} "${target.name}".`
      }
      return `Unknown op "${op}".`
    } catch (e) {
      return `[Home Assistant] ${(e as Error).message}`
    }
  })
  add('AirPlay', {}, async args => {
    const { bridgeDevices, bridgePlay, bridgeStop, bridgeVolume, bridgeAnnounce, bridgeResolve, pcmToWav } = await import('../connectors/bridge.js')
    try {
      const op = String(args?.op || 'list')
      const { speakers, printers } = await bridgeDevices()
      if (op === 'list') {
        if (!speakers.length && !printers.length) return 'The LAN bridge sees no AirPlay devices or printers yet (it rescans every 2 minutes).'
        let out = speakers.length ? 'AirPlay devices (directly reachable, no HA needed): ' + speakers.map(s => `${s.name} (${s.model || s.protocols.join('/')})`).join(' · ') : 'No AirPlay devices found.'
        if (printers.length) out += `\nNetwork printers: ${printers.map(p => p.name).join(' · ')} — use the Print tool.`
        return out
      }
      const dev = bridgeResolve(speakers, String(args?.device || ''))
      if (!dev) return `No AirPlay device matching "${args?.device || ''}". Available: ${speakers.map(s => s.name).join(', ') || 'none'}.`
      if (op === 'stop') { await bridgeStop(dev.id); return `Stopped playback on ${dev.name}.` }
      if (op === 'volume') {
        const level = Math.max(0, Math.min(100, Number(args?.level)))
        if (!Number.isFinite(level)) return 'Give level: 0-100.'
        await bridgeVolume(dev.id, level)
        return `${dev.name} volume → ${level}.`
      }
      if (op === 'play') {
        const url = String(args?.url || '').trim()
        if (!/^https?:\/\//.test(url)) return 'op:play needs a direct http(s) audio URL (mp3/wav/flac/ogg stream or file).'
        await bridgePlay(dev.id, url)
        return `Streaming to ${dev.name}. Stop with op:'stop'.`
      }
      if (op === 'say') {
        const text = String(args?.text || '').trim()
        if (!text) return 'What should I say?'
        const ttsBase = (process.env.ORB2_TTS_URL || '').replace(/\/+$/, '')
        if (!ttsBase) return 'TTS is not configured (ORB2_TTS_URL) — cannot speak, but op:play with an audio URL works.'
        const res = await fetch(`${ttsBase}/tts`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, voice: process.env.ORB2_TTS_VOICE || undefined }),
        })
        if (!res.ok) return `TTS failed (${res.status}) — nothing played.`
        const rate = Number(res.headers.get('X-Sample-Rate')) || 24000
        const wav = pcmToWav(new Uint8Array(await res.arrayBuffer()), rate)
        await bridgeAnnounce(dev.id, wav, 'audio/wav')
        return `Speaking on ${dev.name}: "${text.slice(0, 80)}"`
      }
      return `Unknown op '${op}'.`
    } catch (e) {
      return `[AirPlay bridge] ${(e as Error).message}`
    }
  })
  add('Print', {}, async args => {
    const { bridgeDevices, bridgePrinterStatus, bridgePrint, bridgeResolve } = await import('../connectors/bridge.js')
    try {
      const op = String(args?.op || 'list')
      const { printers } = await bridgeDevices()
      if (op === 'list') {
        if (!printers.length) return 'No network printers found (the bridge rescans continuously — is the printer awake?).'
        return 'Network printers (direct IPP, no setup needed): ' + printers.map(p => `${p.name} @ ${p.address} — accepts: ${p.pdl.join(', ') || 'unknown'}`).join('\n')
      }
      const dev = printers.length === 1 && !args?.printer ? printers[0]! : bridgeResolve(printers, String(args?.printer || ''))
      if (!dev) return `No printer matching "${args?.printer || ''}". Available: ${printers.map(p => p.name).join(', ') || 'none'}.`
      if (op === 'status') {
        const s = await bridgePrinterStatus(dev.id)
        return `${s.make || dev.name}: ${s.state}${s.reasons?.length && s.reasons[0] !== 'none' ? ` (${s.reasons.join(', ')})` : ''}. Accepts: ${s.formats.join(', ')}.`
      }
      if (op === 'print') {
        const accepts = (m: string) => dev.pdl.some(f => f.toLowerCase() === m)
        if (typeof args?.text === 'string' && args.text.trim()) {
          // Plain text: text/plain when advertised, else raw passthrough —
          // laser printers render plain ASCII sent as octet-stream.
          const fmt = accepts('text/plain') ? 'text/plain' : 'application/octet-stream'
          const body = new TextEncoder().encode(args.text.replace(/\n/g, '\r\n') + '\r\n\f')
          const r = await bridgePrint(dev.id, body, fmt, 'orb note')
          return r.ok ? `Printed on ${dev.name} (job ${r.job_id ?? '?'}).` : `Printer rejected the job (IPP status ${r.ipp_status}).`
        }
        const file = String(args?.file || '').trim()
        if (!file) return "Give text:'...' or file:'<workspace path>' to print."
        const { join, resolve } = await import('node:path')
        const wsRoot = process.env.ORB2_API_WORKSPACE_ROOT || '/workspace'
        const full = resolve(join(wsRoot, ctx.sessionId, file))
        if (!full.startsWith(resolve(wsRoot))) return 'File must be inside the session workspace.'
        const ext = (file.split('.').pop() || '').toLowerCase()
        const mime = ({ pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', txt: 'text/plain' } as Record<string, string>)[ext]
        if (!mime) return `Can't determine a print format for .${ext} — pdf, jpg, png or txt.`
        if (!accepts(mime) && !(mime === 'text/plain' && accepts('application/octet-stream'))) {
          return `${dev.name} does not accept ${mime} (it takes: ${dev.pdl.join(', ')}). Printing that would need format conversion Orb doesn't do yet — plain text printing works.`
        }
        const { readFile } = await import('node:fs/promises')
        const doc = await readFile(full)
        const r = await bridgePrint(dev.id, new Uint8Array(doc), accepts(mime) ? mime : 'application/octet-stream', file)
        return r.ok ? `Printed ${file} on ${dev.name} (job ${r.job_id ?? '?'}).` : `Printer rejected the job (IPP status ${r.ipp_status}).`
      }
      return `Unknown op '${op}'.`
    } catch (e) {
      return `[Print bridge] ${(e as Error).message}`
    }
  })
  add('Receipts', { readOnly: true }, async args => {
    const { listReceipts, undoReceipt } = await import('../policy/policy.js')
    const op = String(args?.op || 'list')
    if (op === 'undo') {
      const receipts = await listReceipts(ctx.store, 50)
      const target = args?.id
        ? receipts.find(r => r.id === args.id)
        : receipts.find(r => r.inverse && !r.undone)
      if (!target) return 'Nothing recent can be undone automatically.'
      const done = await undoReceipt(ctx.store, target.id)
      return done ?? 'That one has no automatic inverse.'
    }
    const receipts = await listReceipts(ctx.store, 20)
    if (!receipts.length) return 'No actions recorded yet.'
    emitWidget(ctx.sessionId, { id: 'receipts', type: 'receipts', title: 'What Orb did', receipts } as any)
    return 'Recent actions: ' + receipts.slice(0, 6).map(r => `${r.summary}${r.undone ? ' (undone)' : ''}`).join(' · ')
  })
  add('Settings', {}, async args => {
    const op = String(args?.op || 'open')
    const { SETTINGS_KEYS, SETTINGS_PLAINTEXT_KEYS } = await import('../settingsKeys.js')
    if (op === 'open') {
      const section = String(args?.section || '').trim().toLowerCase()
      emitWidget(ctx.sessionId, { id: 'ui-settings', type: 'ui-settings', section } as any)
      return `Opened the Settings panel${section ? ` at "${section}"` : ''}.`
    }
    if (op === 'get') {
      const want = String(args?.key || '').trim()
      const keys = want ? (SETTINGS_KEYS as readonly string[]).filter(k => k === want) : (SETTINGS_KEYS as readonly string[])
      if (want && !keys.length) return `"${want}" is not a configurable setting. Known keys: ${SETTINGS_KEYS.join(', ')}`
      const rows = await Promise.all(keys.map(async k => {
        const v = process.env[k] ?? (await ctx.store.getKv(`setting:${k}`)) ?? ''
        const shown = !v ? '(unset)' : SETTINGS_PLAINTEXT_KEYS.has(k) ? v : '•set•'
        return `${k}=${shown}`
      }))
      return rows.join('\n')
    }
    if (op === 'connect') {
      const paste = String(args?.value || args?.key || '').trim()
      const { SETTINGS_KEYS } = await import('../settingsKeys.js')
      const { detectKey } = await import('../connectors/keyDetect.js')
      const matches = detectKey(paste)
      if (!matches.length) return "I don't recognize that credential's shape. Tell me which service it's for and I'll set it with op:'set'."
      const certain = matches.filter(m => m.certain)
      if (certain.length !== 1) {
        return `That looks like it could be: ${matches.map(m => m.service).join(' OR ')}. Ask the user which one, then op:'set' with the matching key (${matches.map(m => m.setting).join(' / ')}).`
      }
      const m = certain[0]!
      if (!(SETTINGS_KEYS as readonly string[]).includes(m.setting)) {
        return `Recognized: ${m.service}. ${m.note || 'This one is not a local setting.'}`
      }
      const { CRITICAL_SETTINGS } = await import('../settingsKeys.js')
      if (CRITICAL_SETTINGS.has(m.setting)) {
        const { isOwner } = await import('../auth/otp.js')
        const email = ctx.ownerId.replace(/^user:/, '')
        if (email.includes('@') && !(await isOwner(ctx.store, email))) {
          return `That's a ${m.service} credential — a critical setting only a household OWNER can change.`
        }
      }
      await ctx.store.putKv(`setting:${m.setting}`, paste, 0)
      process.env[m.setting] = paste
      return `Recognized a ${m.service} credential and connected it (${m.setting}).${m.note ? ' ' + m.note : ''} The matching features are live now.`
    }
    if (op === 'set') {
      const key = String(args?.key || '').trim()
      const value = String(args?.value ?? '').trim()
      if (!(SETTINGS_KEYS as readonly string[]).includes(key)) return `"${key}" is not a settable key. Known keys: ${SETTINGS_KEYS.join(', ')}`
      if (!value) return 'Provide a value.'
      const { CRITICAL_SETTINGS } = await import('../settingsKeys.js')
      if (CRITICAL_SETTINGS.has(key)) {
        const { isOwner } = await import('../auth/otp.js')
        const email = ctx.ownerId.replace(/^user:/, '')
        if (email.includes('@') && !(await isOwner(ctx.store, email))) {
          return `"${key}" is a critical setting — only a household OWNER can change it. Tell them what you need, or ask an owner to do it.`
        }
      }
      await ctx.store.putKv(`setting:${key}`, value, 0)
      process.env[key] = value
      return `Set ${key}${SETTINGS_PLAINTEXT_KEYS.has(key) ? ` = ${value}` : ''} (live).${/BASE_URL|API_KEY/.test(key) ? ' A restart may be needed for the brain endpoint to fully switch.' : ''}`
    }
    return `Unknown op "${op}".`
  })
  add('Family', {}, async args => {
    const op = String(args?.op || 'board')
    const fam = await import('../family/family.js')
    const { getUsers } = await import('../auth/otp.js')
    const me = fam.emailFromOwnerId(ctx.ownerId)
    const boardSpec = async () => {
      const [notes, events] = await Promise.all([fam.listNotes(ctx.store), fam.listEvents(ctx.store)])
      const named = await Promise.all(notes.slice(-12).reverse().map(async n => ({
        from: await fam.memberName(ctx.store, n.from), to: await fam.memberName(ctx.store, n.to),
        text: n.text, trigger: n.trigger, delivered: !!n.delivered,
      })))
      return { id: 'familyboard', type: 'familyboard', title: 'Family board', notes: named,
        events: events.slice(0, 6), pill: `${notes.filter(n => !n.delivered).length} waiting` }
    }
    try {
      if (op === 'members') {
        const users = await getUsers(ctx.store)
        return 'Household: ' + users.map((u, i) => `${u.label || u.email.split('@')[0]} <${u.email}> (${u.role ?? (i === 0 ? 'owner' : 'member')}${u.telegram_chat_id ? ', telegram' : ''})`).join(' · ')
      }
      if (op === 'routine_add') {
        const rec = await fam.resolveMember(ctx.store, String(args?.to || '')) || (await fam.resolveMember(ctx.store, me))
        if (!rec) return 'Who is this reminder for?'
        const r = await fam.addRoutine(ctx.store, { label: String(args?.label || args?.text || '').trim(), at: String(args?.at || ''), days: Array.isArray(args?.day) ? args.day : (Array.isArray((args as any)?.days) ? (args as any).days : undefined), to: rec.email })
        if ('error' in r) return `[Family] ${r.error}`
        return `Routine set: "${r.label}" at ${r.at}${r.days ? ' on ' + r.days.map(d => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d]).join('/') : ' every day'} → ${rec.label || rec.email.split('@')[0]}.`
      }
      if (op === 'routines') {
        const rs = await fam.listRoutines(ctx.store)
        if (!rs.length) return 'No routines yet — e.g. routine_add {label:"Morning meds", at:"08:00", to:"me"}.'
        const named = await Promise.all(rs.map(async r => `${r.at} ${r.label} → ${await fam.memberName(ctx.store, r.to)}${r.days ? ' (' + r.days.map(d => ['Su','Mo','Tu','We','Th','Fr','Sa'][d]).join(',') + ')' : ''}`))
        return 'Routines: ' + named.join(' · ')
      }
      if (op === 'routine_remove') {
        const gone = await fam.removeRoutine(ctx.store, String(args?.query || ''))
        return gone ? `Removed routine "${gone.label}".` : 'No routine matching that.'
      }
      if (op === 'briefing') {
        const { buildBriefing, briefingText, briefingWidgetSpec } = await import('../home/briefing.js')
        const b = await buildBriefing(ctx.store)
        emitWidget(ctx.sessionId, briefingWidgetSpec(b) as any)
        return briefingText(b) + ' (Shown in the Today widget. Owners can schedule this daily via the ORB2_BRIEFING_TIME setting, e.g. 07:30.)'
      }
      if (op === 'pref') {
        const key = String(args?.title || args?.label || args?.query || args?.key || '').trim() || 'note'
        const value = String(args?.text || args?.value || args?.message || '').trim()
        await fam.setPref(ctx.store, me, key, value)
        return value ? `Noted — ${key}: ${value}. I'll remember that for you specifically.` : `Cleared your "${key}" preference.`
      }
      if (op === 'prefs') {
        const prefs = await fam.getPrefs(ctx.store, me)
        const entries = Object.entries(prefs)
        return entries.length ? 'Your preferences: ' + entries.map(([k, v]) => `${k}: ${v}`).join(' · ') : 'No personal preferences saved yet.'
      }
      if (op === 'chore_add') {
        const rec = await fam.resolveMember(ctx.store, String(args?.to || args?.who || ''))
        if (!rec) return `Who is this chore for? I don't know "${args?.to || args?.who}".`
        const title = String(args?.title || args?.text || '').trim()
        if (!title) return 'What is the chore?'
        const day = args?.day != null && Number(args.day) >= 0 && Number(args.day) <= 6 ? Number(args.day) : undefined
        await fam.addChore(ctx.store, title, rec.email, day)
        return `Chore added: "${title}" → ${rec.label || rec.email.split('@')[0]}${day !== undefined ? ` (every ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][day]})` : ''}.`
      }
      if (op === 'chore_done') {
        const c = await fam.completeChore(ctx.store, String(args?.query || args?.title || ''))
        return c ? `Nice — "${c.title}" marked done.` : `No open chore matching that.`
      }
      if (op === 'chores') {
        const chores = await fam.listChores(ctx.store)
        if (!chores.length) return 'No chores on the rota.'
        const named = await Promise.all(chores.map(async c => `${c.title} → ${await fam.memberName(ctx.store, c.who)}${c.done ? ' ✓' : ''}${c.day !== undefined ? ` (${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][c.day]})` : ''}`))
        return 'Chores: ' + named.join(' · ')
      }
      if (op === 'note') {
        const rec = await fam.resolveMember(ctx.store, String(args?.to || ''))
        if (!rec) return `I don't know "${args?.to}". Household members: ${(await getUsers(ctx.store)).map(u => u.label || u.email.split('@')[0]).join(', ')}.`
        const text = String(args?.text || '').trim()
        if (!text) return 'What should the note say?'
        const trigger = args?.when === 'home' ? 'home' : 'next'
        await fam.addNote(ctx.store, me, rec.email, text, trigger)
        emitWidget(ctx.sessionId, await boardSpec() as any)
        if (trigger === 'home' && !rec.person_entity) {
          return `Note saved for ${rec.label || rec.email}. Heads-up: they have no presence link yet (no HA person attached), so I'll also deliver it on their next chat. An owner can link one via the users settings.`
        }
        return `Saved — I'll pass it to ${rec.label || rec.email.split('@')[0]} ${trigger === 'home' ? 'when they get home' : 'next time they talk to me'}.`
      }
      if (op === 'remind') {
        const rec = await fam.resolveMember(ctx.store, String(args?.to || ''))
        if (!rec) return `I don't know "${args?.to}".`
        const label = String(args?.label || 'Reminder').trim()
        let at: number | null = null
        if (args?.minutes != null && Number(args.minutes) > 0) at = Date.now() + Number(args.minutes) * 60_000
        else if (typeof args?.at === 'string' && /^\d{1,2}:\d{2}$/.test(args.at.trim())) {
          const [h, m] = args.at.trim().split(':').map(Number)
          const d = new Date(); d.setHours(h!, m!, 0, 0)
          if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1)
          at = d.getTime()
        }
        if (!at) return "Give me minutes or at:'HH:MM'."
        const { addTimer } = await import('../home/timers.js')
        await addTimer(ctx.store, `${label} → ${rec.email}`, at, ctx.sessionId, rec.email)
        return `Set — I'll remind ${rec.label || rec.email.split('@')[0]} ${Math.round((at - Date.now()) / 60_000)} min from now${rec.telegram_chat_id ? ' on their Telegram' : " (no Telegram linked — it'll reach the house channels)"}.`
      }
      if (op === 'calendar_add') {
        const r = await fam.addEvent(ctx.store, { title: String(args?.title || ''), date: String(args?.date || ''), time: args?.time ? String(args.time) : undefined, who: args?.who ? String(args.who) : undefined, repeat: (args as any)?.repeat === 'yearly' ? 'yearly' : undefined })
        if ('error' in r) return `[Family] ${r.error}`
        const events = await fam.listEvents(ctx.store)
        emitWidget(ctx.sessionId, { id: 'familycal', type: 'calendar', title: 'Family calendar',
          events: events.map(e => ({ date: e.date, title: `${e.time ? e.time + ' ' : ''}${e.title}${e.who ? ` (${e.who})` : ''}` })) } as any)
        return `Added "${r.title}" on ${r.date}${r.time ? ` at ${r.time}` : ''} to the family calendar.`
      }
      if (op === 'calendar_remove') {
        const gone = await fam.removeEvent(ctx.store, String(args?.query || ''))
        return gone ? `Removed "${gone.title}".` : `Nothing matching "${args?.query}" on the calendar.`
      }
      if (op === 'calendar') {
        const events = await fam.listEvents(ctx.store)
        emitWidget(ctx.sessionId, { id: 'familycal', type: 'calendar', title: 'Family calendar',
          events: events.map(e => ({ date: e.date, title: `${e.time ? e.time + ' ' : ''}${e.title}${e.who ? ` (${e.who})` : ''}` })) } as any)
        return events.length ? `Family calendar: ${events.slice(0, 8).map(e => `${e.date}${e.time ? ' ' + e.time : ''} ${e.title}`).join(' · ')}.` : 'The family calendar is empty.'
      }
      if (op === 'announce') {
        const msg = String(args?.message || '').trim()
        if (!msg) return 'What should I announce?'
        if (!haEnabled()) return 'No speakers available (Home Assistant not configured).'
        const [ttsEntities, players] = await Promise.all([haStates(['tts']), haJoinAreas(await haStates(['media_player']))])
        const tts = ttsEntities[0]
        let targets = players.filter(p => p.state !== 'unavailable')
        const where = String(args?.where || '').trim().toLowerCase()
        if (where && targets.length) {
          const narrowed = targets.filter(p =>
            (p.area || '').toLowerCase().includes(where) || p.name.toLowerCase().includes(where))
          if (!narrowed.length) return `No reachable speaker matching "${args?.where}". Speakers: ${targets.map(p => `${p.name}${p.area ? ` (${p.area})` : ''}`).join(', ')}.`
          targets = narrowed
        }
        if (!tts || !targets.length) return 'No TTS engine or reachable speakers in Home Assistant.'
        for (const p of targets.slice(0, 4)) {
          await haCallService('tts', 'speak', tts.entity_id, { media_player_entity_id: p.entity_id, message: msg })
        }
        return `Announced on ${targets.slice(0, 4).map(p => p.name).join(', ')}: "${msg}"`
      }
      emitWidget(ctx.sessionId, await boardSpec() as any)
      const notes = await fam.listNotes(ctx.store)
      return notes.length ? `Family board is up — ${notes.filter(n => !n.delivered).length} note(s) waiting, ${notes.length} total.` : 'Family board is up — empty right now.'
    } catch (e) { return `[Family] ${(e as Error).message}` }
  })
  add('Timer', {}, async args => {
    const op = String(args?.op || 'list')
    const { listTimers, addTimer, cancelTimer, timerWidgetSpec } = await import('../home/timers.js')
    try {
      if (op === 'connect') {
      const paste = String(args?.value || args?.key || '').trim()
      const { SETTINGS_KEYS } = await import('../settingsKeys.js')
      const { detectKey } = await import('../connectors/keyDetect.js')
      const matches = detectKey(paste)
      if (!matches.length) return "I don't recognize that credential's shape. Tell me which service it's for and I'll set it with op:'set'."
      const certain = matches.filter(m => m.certain)
      if (certain.length !== 1) {
        return `That looks like it could be: ${matches.map(m => m.service).join(' OR ')}. Ask the user which one, then op:'set' with the matching key (${matches.map(m => m.setting).join(' / ')}).`
      }
      const m = certain[0]!
      if (!(SETTINGS_KEYS as readonly string[]).includes(m.setting)) {
        return `Recognized: ${m.service}. ${m.note || 'This one is not a local setting.'}`
      }
      const { CRITICAL_SETTINGS } = await import('../settingsKeys.js')
      if (CRITICAL_SETTINGS.has(m.setting)) {
        const { isOwner } = await import('../auth/otp.js')
        const email = ctx.ownerId.replace(/^user:/, '')
        if (email.includes('@') && !(await isOwner(ctx.store, email))) {
          return `That's a ${m.service} credential — a critical setting only a household OWNER can change.`
        }
      }
      await ctx.store.putKv(`setting:${m.setting}`, paste, 0)
      process.env[m.setting] = paste
      return `Recognized a ${m.service} credential and connected it (${m.setting}).${m.note ? ' ' + m.note : ''} The matching features are live now.`
    }
    if (op === 'set') {
        const label = String(args?.label || 'Timer').trim()
        let at: number | null = null
        if (args?.minutes != null && Number(args.minutes) > 0) at = Date.now() + Number(args.minutes) * 60_000
        else if (typeof args?.at === 'string' && /^\d{1,2}:\d{2}$/.test(args.at.trim())) {
          const [h, m] = args.at.trim().split(':').map(Number)
          const d = new Date(); d.setHours(h!, m!, 0, 0)
          if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1)
          at = d.getTime()
        }
        if (!at) return "Give me a duration (minutes) or a time (at:'HH:MM')."
        await addTimer(ctx.store, label, at, ctx.sessionId)
        const timers = await listTimers(ctx.store)
        emitWidget(ctx.sessionId, timerWidgetSpec(timers) as any)
        const mins = Math.round((at - Date.now()) / 60_000)
        return `Set: "${label}" — fires ${mins < 90 ? `in ${mins} min` : `at ${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}. I'll notify you when it's time.`
      }
      if (op === 'cancel') {
        const gone = await cancelTimer(ctx.store, String(args?.query || ''))
        if (!gone) return `No timer matching "${args?.query}".`
        emitWidget(ctx.sessionId, timerWidgetSpec(await listTimers(ctx.store)) as any)
        return `Cancelled "${gone.label}".`
      }
      const timers = await listTimers(ctx.store)
      emitWidget(ctx.sessionId, timerWidgetSpec(timers) as any)
      return timers.length
        ? 'Running: ' + timers.map(t => `${t.label} (${Math.max(0, Math.round((t.at - Date.now()) / 60_000))} min left)`).join(' · ')
        : 'No timers running.'
    } catch (e) { return `[Timer] ${(e as Error).message}` }
  })
  add('Shopping', {}, async args => {
    const op = String(args?.op || 'show')
    const { shoppingList, saveShoppingList, newShoppingItem } = await import('../shopping/routes.js')
    const emitList = async (extra: Record<string, any> = {}) => {
      const items = await shoppingList(ctx.store)
      emitWidget(ctx.sessionId, { id: 'shopping', type: 'shopping', title: 'Shopping',
        pill: `${items.filter(i => !i.done).length} to buy`, items, ...extra } as any)
      return items
    }
    try {
      if (op === 'show') {
        const items = await emitList()
        return items.length ? `Showed the shopping list: ${items.map(i => `${i.name}${i.done ? ' ✓' : ''}`).join(', ')}.` : 'Showed the shopping list — it is empty.'
      }
      if (op === 'add') {
        const raw = Array.isArray(args?.items) ? args.items : (args?.query ? [args.query] : [])
        if (!raw.length) return 'What should I add? Pass items:[...].'
        const items = await shoppingList(ctx.store)
        const added: string[] = []
        for (const r of raw.slice(0, 20)) {
          const name = typeof r === 'string' ? r : String(r?.name || '')
          if (!name.trim()) continue
          items.push(newShoppingItem(name, typeof r === 'object' ? Number(r?.qty) || undefined : undefined, typeof r === 'object' && r?.note ? String(r.note) : undefined, typeof r === 'object' ? Number(r?.every_days) || undefined : undefined))
          added.push(name.trim())
        }
        await saveShoppingList(ctx.store, items)
        await emitList()
        return `Added ${added.join(', ')} to the shopping list (${items.filter(i => !i.done).length} open items).`
      }
      if (op === 'remove') {
        const q = String(args?.query || '').trim().toLowerCase()
        if (!q) return 'Which item should I remove?'
        const items = await shoppingList(ctx.store)
        const idx = items.findIndex(i => i.name.toLowerCase().includes(q))
        if (idx < 0) return `Nothing on the list matching "${args?.query}".`
        const [gone] = items.splice(idx, 1)
        await saveShoppingList(ctx.store, items)
        await emitList()
        return `Removed ${gone!.name}.`
      }
      if (op === 'options') {
        const q = String(args?.query || '').trim()
        if (!q) return 'What product should I research?'
        const links = onlineOptions(q)
        let digest = ''
        try {
          const hits = await webSearch(`${q} price buy`, 6)
          digest = hits.slice(0, 5).map(h => `- ${h.title}: ${h.snippet.slice(0, 120)}`).join('\n')
        } catch { /* links still useful without live prices */ }
        await emitList({ options: { query: q, merchants: links } })
        return `Buy options for "${q}" are in the shopping widget (Amazon, Walmart, Google Shopping, eBay).${digest ? `\nLive price signals from the web:\n${digest}\nSummarize the best 2-3 options for the user.` : ''}`
      }
      if (op === 'checkout') {
        const q = String(args?.query || '').trim()
        const items = await shoppingList(ctx.store)
        const targets = q ? items.filter(i => i.name.toLowerCase().includes(q.toLowerCase())) : items.filter(i => !i.done)
        if (!targets.length) return 'Nothing to check out.'
        const links = targets.map(t => `${t.name}: https://www.amazon.com/s?k=${encodeURIComponent(t.name)}`)
        await emitList({ checkout: targets.map(t => t.name) })
        return `Checkout handoff ready. Amazon links (payment happens in the user's Amazon account):\n${links.join('\n')}\nFor non-Amazon merchants, show the Wallet (Wallet op:show) so the user picks how to pay. Do NOT claim any order was placed.`
      }
      return `Unknown op "${op}".`
    } catch (e) { return `[Shopping] ${(e as Error).message}` }
  })
  add('CreateWidget', {}, async args => {
    const op = String(args?.op || 'template')
    const { installPlugin, removePlugin, listPlugins } = await import('../widgets/plugins.js')
    if (op === 'template') return WIDGET_TEMPLATE_GUIDE
    if (op === 'list') {
      const ps = listPlugins()
      return ps.length ? 'Custom widgets: ' + ps.map(p => `${p.id} ("${p.name}")`).join(', ') : 'No custom widgets installed.'
    }
    if (op === 'remove') {
      const id = String(args?.id || '').trim()
      return removePlugin(id) ? `Removed custom widget "${id}".` : `No custom widget "${id}".`
    }
    if (op === 'install') {
      try {
        const p = installPlugin({
          id: String(args?.id || ''), name: String(args?.name || ''), icon: String(args?.icon || '🧩'),
          render_js: String(args?.render_js || ''),
        })
        return `Installed widget type "${p.id}". Now display data with: Widget { type: "${p.id}", title: "...", ...your fields }. The console picks it up automatically.`
      } catch (e) { return `[CreateWidget] ${(e as Error).message}. Fix the input and retry — op:'template' shows the contract.` }
    }
    return `Unknown op "${op}".`
  })
  add('Wallet', { readOnly: true }, async args => {
    const op = String(args?.op || 'show')
    const { walletMethods } = await import('../wallet/routes.js')
    const { methods, selected } = await walletMethods(ctx.store)
    const label = (m: any) => `${m.label}${m.brand ? ` (${m.brand}${m.last4 ? ` ····${m.last4}` : ''})` : ''}${m.id === selected ? ' [selected]' : ''}`
    if (op === 'show') {
      emitWidget(ctx.sessionId, { id: 'wallet', type: 'wallet', title: 'Wallet', methods, selected } as any)
      return methods.length
        ? `Showed the wallet. Methods: ${methods.map(label).join(' · ')}. The user selects/confirms in the widget — never assume a choice.`
        : 'Showed the wallet — it is empty. The user can add a payment method right in the widget.'
    }
    if (op === 'list') return methods.length ? methods.map(label).join(' · ') : 'No payment methods saved yet.'
    if (op === 'selected') {
      const m = methods.find(x => x.id === selected)
      return m ? `Selected: ${label(m)}` : 'No payment method selected yet — use op:show so the user can pick one.'
    }
    return `Unknown op "${op}".`
  })

  return tools
}

/** Contract + starter the agent copies when minting a new widget type. */
const WIDGET_TEMPLATE_GUIDE = `WIDGET CONTRACT
- render.js runs inside the console card body. Export: function render(el, spec, api)
- el: the card's body element (a flex column). Build DOM inside it.
- spec: the exact JSON you pass to the Widget tool ({type, title, ...your fields}).
- api.esc(s): HTML-escape — use it on EVERY interpolated string.
- Style with the console's CSS variables: var(--ink) text, var(--ink-dim) muted,
  var(--nv) green accent, var(--line) hairline, var(--mono) monospace font.
- No external scripts, no fetch to the internet, no innerHTML of unescaped data.

STARTER (adapt freely):
export function render(el, spec, api){
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
  const items = Array.isArray(spec.items) ? spec.items : [];
  if (!items.length){
    wrap.innerHTML = '<div style="color:var(--ink-dim);text-align:center;padding:20px;">Nothing here yet.</div>';
  }
  for (const it of items){
    const row = document.createElement('div');
    row.style.cssText = 'padding:8px 10px;border:1px solid var(--line);border-radius:10px;';
    row.innerHTML = '<div style="font-size:13px;color:var(--ink);">'+api.esc(it.title||'')+'</div>'
      + '<div style="font-size:11px;color:var(--ink-dim);">'+api.esc(it.detail||'')+'</div>';
    wrap.appendChild(row);
  }
  el.appendChild(wrap);
}

Install with CreateWidget op:'install' {id:'my-widget', name:'My widget', icon:'🧩', render_js:'<the source>'} then emit Widget {type:'my-widget', title:'...', items:[...]}.`

/**
 * The user's home location as a short label. Prefers the ORB2_HOME_LOCATION
 * setting; falls back to Home Assistant's configured coordinates (set during
 * HA onboarding), reverse-geocoded once and cached in the process env so the
 * whole stack agrees on where "home" is.
 */
async function homeLocation(): Promise<string | null> {
  const set = (process.env.ORB2_HOME_LOCATION || '').trim()
  if (set) return set
  const cfg = await haConfig()
  if (cfg?.latitude == null || cfg?.longitude == null) return null
  try {
    const label = await reverseGeocode(cfg.latitude, cfg.longitude)
    if (label) { process.env.ORB2_HOME_LOCATION = label; return label }
  } catch { /* fall through */ }
  return null
}


/** Human label for an HA domain. */

/** One-line attribute summary for a device's status card. */

/** Map a friendly action onto a Home Assistant domain/service + data. */
function planControl(
  e: HaEntity,
  action: string,
  value?: number,
): { domain: string; service: string; data: Record<string, any>; confirm: (n: string) => string } | null {
  const d = e.domain
  const set = value
  switch (d) {
    case 'light':
      if (action === 'on') return { domain: d, service: 'turn_on', data: set != null ? { brightness_pct: set } : {}, confirm: n => `turned on ${n}${set != null ? ` at ${set}%` : ''}` }
      if (action === 'off') return { domain: d, service: 'turn_off', data: {}, confirm: n => `turned off ${n}` }
      if (action === 'toggle') return { domain: d, service: 'toggle', data: {}, confirm: n => `toggled ${n}` }
      if (action === 'set' && set != null) return { domain: d, service: 'turn_on', data: { brightness_pct: set }, confirm: n => `set ${n} to ${set}%` }
      return null
    case 'switch':
    case 'fan':
      if (action === 'on') return { domain: d, service: 'turn_on', data: {}, confirm: n => `turned on ${n}` }
      if (action === 'off') return { domain: d, service: 'turn_off', data: {}, confirm: n => `turned off ${n}` }
      if (action === 'toggle') return { domain: d, service: 'toggle', data: {}, confirm: n => `toggled ${n}` }
      return null
    case 'lock':
      if (action === 'lock') return { domain: d, service: 'lock', data: {}, confirm: n => `locked ${n}` }
      if (action === 'unlock') return { domain: d, service: 'unlock', data: {}, confirm: n => `unlocked ${n}` }
      return null
    case 'cover':
      if (action === 'open') return { domain: d, service: 'open_cover', data: {}, confirm: n => `opened ${n}` }
      if (action === 'close') return { domain: d, service: 'close_cover', data: {}, confirm: n => `closed ${n}` }
      if (action === 'set' && set != null) return { domain: d, service: 'set_cover_position', data: { position: set }, confirm: n => `set ${n} to ${set}% open` }
      return null
    case 'climate':
      if (action === 'set' && set != null) return { domain: d, service: 'set_temperature', data: { temperature: set }, confirm: n => `set ${n} to ${set}°` }
      if (action === 'off') return { domain: d, service: 'turn_off', data: {}, confirm: n => `turned off ${n}` }
      if (action === 'on') return { domain: d, service: 'turn_on', data: {}, confirm: n => `turned on ${n}` }
      return null
    case 'media_player':
      if (action === 'on') return { domain: d, service: 'turn_on', data: {}, confirm: n => `turned on ${n}` }
      if (action === 'off') return { domain: d, service: 'turn_off', data: {}, confirm: n => `turned off ${n}` }
      if (action === 'play') return { domain: d, service: 'media_play', data: {}, confirm: n => `resumed ${n}` }
      if (action === 'pause') return { domain: d, service: 'media_pause', data: {}, confirm: n => `paused ${n}` }
      if (action === 'set' && set != null) return { domain: d, service: 'volume_set', data: { volume_level: Math.max(0, Math.min(1, set / 100)) }, confirm: n => `set ${n} volume to ${set}%` }
      return null
    case 'vacuum':
      if (action === 'start') return { domain: d, service: 'start', data: {}, confirm: n => `started ${n}` }
      if (action === 'stop') return { domain: d, service: 'stop', data: {}, confirm: n => `stopped ${n}` }
      if (action === 'dock') return { domain: d, service: 'return_to_base', data: {}, confirm: n => `sent ${n} back to dock` }
      return null
    default:
      return null
  }
}
