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
import { youtubeEnabled, youtubeSearch } from '../connectors/youtube.js'
import { spotifyEnabled, spotifySearch } from '../connectors/spotify.js'
import { spotifyApi, getUserToken } from '../connectors/spotifyOAuth.js'
import { newsEnabled, newsSearch } from '../connectors/news.js'
import { vercelEnabled, deployToVercel } from '../connectors/vercel.js'
import { cloudStorageEnabled, searchCloud, downloadCloudFile, connectedProviders } from '../connectors/cloudStorage.js'
import { geocode, route as geoRoute, weather, reverseGeocode } from '../connectors/geo.js'
import { webSearch, webSearchEnabled } from '../connectors/websearch.js'
import { haConfig, haAreas, haCreateArea, haUpdateEntity, haAreaByEntity, haJoinAreas, toDeviceCard, prettyDomain, describeAttrs } from '../connectors/homeAssistant.js'
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
      description: "Create or edit a 3D model with Blender — you write a Blender Python (bpy) script that builds the scene. The scene is CLEARED before each run and your script rebuilds the WHOLE thing, so to iterate (add/modify/remove objects) re-send the full updated script with the SAME id. It renders an interactive 3D model widget the user can orbit/zoom, refreshing every time you call it. `bpy`, `math`, `mathutils` are already imported; do NOT export — glTF export is automatic. Use for 'make a 3D <thing>', 'add a <part>', 'make it taller', etc.",
      input_schema: { type: 'object', properties: {
        script: { type: 'string', description: 'Blender Python (bpy) building the full scene (pre-cleared; export is automatic).' },
        title: { type: 'string' },
        id: { type: 'string', description: 'Reuse the same id to update the same model widget as you iterate.' },
      }, required: ['script'] },
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
        op: { type: 'string', enum: ['list', 'status', 'control', 'media', 'lights', 'climate'], description: "list = overview dashboard; status/control = one device; media = show a media REMOTE widget for TVs/speakers; lights = show the room-grouped LIGHTS widget; climate = show thermostat widgets. Prefer the function widgets (media/lights/climate) when the user is focused on one kind of device." },
        query: { type: 'string', description: "Device name for status/control (e.g. 'living room lights', 'front door', 'bedroom thermostat')." },
        type: { type: 'string', enum: ['light', 'switch', 'climate', 'lock', 'cover', 'media_player', 'vacuum', 'fan', 'sensor', 'camera'], description: 'Optional device type filter for list.' },
        action: { type: 'string', enum: ['on', 'off', 'toggle', 'lock', 'unlock', 'open', 'close', 'play', 'pause', 'start', 'stop', 'dock', 'set'], description: 'What to do for op:control.' },
        value: { type: 'number', description: 'Numeric arg for set: brightness/position/volume 0-100, or thermostat temperature.' },
      }, required: ['op'] },
      available: haEnabled(),
    },
    {
      name: 'HomeAdmin',
      description: "Organize the smart home's structure in Home Assistant — use when the user wants rooms/areas set up, devices renamed to friendly names, devices assigned to rooms, or clutter entities hidden. op:'areas' lists rooms with device counts. op:'create_area' {name} makes a room. op:'assign' {query, area} puts a device in a room (creates the room if needed). op:'rename' {query, name} sets a device's display name. op:'hide' {query, hidden} hides/unhides an entity from dashboards. Refer to devices by their current name (e.g. 'living room tv').",
      input_schema: { type: 'object', properties: {
        op: { type: 'string', enum: ['areas', 'create_area', 'assign', 'rename', 'hide'] },
        query: { type: 'string', description: 'Device to act on, by name.' },
        area: { type: 'string', description: "Room name for op:'assign'." },
        name: { type: 'string', description: "New display name for op:'rename' / op:'create_area'." },
        hidden: { type: 'boolean', description: "op:'hide': true hides, false unhides." },
      }, required: ['op'] },
      available: haEnabled(),
    },
    {
      name: 'Shopping',
      description: "The user's shopping list + buying flow (Amazon and grocery/other). op:'show' displays the shopping widget; op:'add' {items:[{name,qty?,note?}]} adds to the list; op:'remove' {query} removes by name; op:'options' {query} researches buy options with prices (web search + merchant links) and shows them in the widget — use this when the user hasn't named an exact product; op:'checkout' {query?} produces checkout links — Amazon items check out in the user's own Amazon account, other merchants via their site with the Wallet for payment choice. NEVER claim an order was placed — Orb hands off to the merchant, the user completes payment there.",
      input_schema: { type: 'object', properties: {
        op: { type: 'string', enum: ['show', 'add', 'remove', 'options', 'checkout'] },
        items: { type: 'array', description: "op:'add': [{name, qty?, note?}] or plain strings.", items: { type: ['object', 'string'] } },
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
    tools.push(buildTool({
      name: def.name,
      description: def.description,
      inputJSONSchema: def.input_schema,
      readOnly: opts.readOnly,
      destructive: opts.destructive,
      run,
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
    try {
      const hits = await webSearch(q, Math.min(Number(args?.count) || 8, 20))
      if (!hits.length) return `No results for "${q}".`
      emitWidget(ctx.sessionId, {
        id: `search-${Date.now().toString(36)}`, type: 'results', title: `Web · ${q}`,
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
    const script = String(args?.script || '').trim()
    if (!script) return 'Provide a Blender Python (bpy) script that builds the scene.'
    const id = (typeof args?.id === 'string' && args.id.trim()) ? args.id.trim() : 'model-main'
    const wsRoot = process.env.ORB2_API_WORKSPACE_ROOT || '/workspace'
    const out = `${wsRoot}/${ctx.sessionId}/.widget/${id}.glb`
    try {
      const base = (process.env.ORB2_BLENDER_URL || 'http://blender:8996').replace(/\/+$/, '')
      const r = await fetch(`${base}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ script, out }) })
      const d = (await r.json()) as any
      if (!d.ok) return `[ERROR] Blender failed: ${String(d.stderr || d.error || 'unknown').slice(-700)}`
      emitWidget(ctx.sessionId, { id, type: 'model', title: args?.title || '3D model', url: `/v1/workspace/${ctx.sessionId}/.widget/${id}.glb?t=${Date.now()}` } as any)
      return `Rendered the 3D model (id: ${id}). To iterate, call Blender again with id:"${id}" and the full updated script.`
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
          emitWidget(ctx.sessionId, {
            id: `media-${e.entity_id}`, type: 'media', title: e.name,
            entity_id: e.entity_id, name: e.name, area: e.area, state: e.state,
            media_title: e.attributes.media_title, app: e.attributes.app_name,
            volume: e.attributes.volume_level != null ? Math.round(e.attributes.volume_level * 100) : undefined,
            artwork: pic ? `/v1/home/ha-image?path=${encodeURIComponent(pic)}` : undefined,
          } as any)
        }
        return `Showed media remote${players.length > 1 ? 's' : ''} for: ${players.slice(0, 4).map(p => p.name).join(', ')}.`
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
      // Remaining ops act on one device resolved by name.
      const query = String(args?.query || '').trim()
      if (!query) return "Tell me which device — e.g. 'living room tv'."
      const entities = await haStates(HOME_DOMAINS)
      const matches = haResolve(entities, query)
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
          items.push(newShoppingItem(name, typeof r === 'object' ? Number(r?.qty) || undefined : undefined, typeof r === 'object' && r?.note ? String(r.note) : undefined))
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
