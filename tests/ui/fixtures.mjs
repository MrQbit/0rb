// Fixture specs for EVERY widget type — realistic data, network-independent
// where possible (local assets, data URIs). The gallery harness spawns each
// through the real renderer; these shapes mirror what the tools emit.
const IMG = '/assets/icon-192.png';
const now = Date.now();

export const FIXTURES = [
  { type: 'note', title: 'Note', text: 'Dinner at 7 — Ana is bringing dessert. The garage door is closed and the house is set to home.' },
  { type: 'table', title: 'Grocery totals', columns: ['Store', 'Items', 'Total'], rows: [['HEB', '14', '$62.10'], ['Costco', '6', '$118.40'], ['Farmers market', '5', '$23.75']] },
  { type: 'stats', title: 'This week', stats: [ { label: 'Chats', value: '128' }, { label: 'Timers', value: '9', sub: '2 running' }, { label: 'Alerts', value: '1', sub: 'water leak test' } ] },
  { type: 'results', title: 'Search results', items: [
    { title: 'How to descale the espresso machine', subtitle: 'coffeegeek.com · 4 min read' },
    { title: 'Breville Barista maintenance guide', subtitle: 'breville.com' },
    { title: 'Vinegar vs descaler — what actually works', subtitle: 'reddit.com/r/espresso' } ] },
  { type: 'chart', title: 'Energy use', chart_type: 'line', labels: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], datasets: [ { label: 'kWh', data: [12,14,11,16,18,22,17] } ] },
  { type: 'gallery', title: 'Backyard cameras', images: [ { url: IMG, caption: 'North fence' }, { url: IMG, caption: 'Patio' }, { url: IMG, caption: 'Driveway' } ] },
  { type: 'image', title: 'Snapshot', url: IMG, caption: 'Front door, 2 minutes ago' },
  { type: 'weather', title: 'Weather', location: 'Austin', unit: 'F', current: { temp: 97, condition: 'Sunny', humidity: 38, wind: 9, icon: 'sun' }, forecast: [
    { day: 'Wed', high: 99, low: 76, icon: 'sun', condition: 'Sunny' },
    { day: 'Thu', high: 101, low: 77, icon: 'sun', condition: 'Hot' },
    { day: 'Fri', high: 96, low: 74, icon: 'cloud', condition: 'Clouds' },
    { day: 'Sat', high: 92, low: 72, icon: 'rain', condition: 'Storms' },
    { day: 'Sun', high: 90, low: 71, icon: 'sun', condition: 'Clear' } ] },
  { type: 'calendar', title: 'August', month: '2026-08', events: [
    { date: '2026-08-20', title: 'Bambu X2D delivery', time: '10:00' },
    { date: '2026-08-21', title: 'Dentist', time: '14:00' },
    { date: '2026-08-24', title: 'School starts' } ] },
  { type: 'code', title: 'demo.ts', filename: 'demo.ts', language: 'ts', code: 'export function greet(name: string) {\n  return `Hello, ${name}!`\n}\n\nconsole.log(greet("orb"))' },
  { type: 'mail', title: 'Inbox', messages: [
    { from: 'Vercel', subject: 'Deployment ready', preview: 'orb2-app deployed to production', date: '9:12', unread: true },
    { from: 'School', subject: 'Fall schedule', preview: 'Please review the attached schedule…', date: 'Yesterday', unread: false } ] },
  { type: 'vercel', title: 'Deployments', deployments: [
    { name: 'orb2-site', state: 'READY', branch: 'main', created: '2h ago', url: 'https://orb2.app' },
    { name: 'mana', state: 'BUILDING', branch: 'main', created: 'now' } ] },
  { type: 'map', title: 'Downtown', center: [30.2672, -97.7431], zoom: 13, markers: [ { lat: 30.2672, lon: -97.7431, label: 'Austin' } ] },
  { type: 'docker', title: 'Containers', containers: [
    { name: 'orb2-api', image: 'orb2-api:dev', state: 'running', cpu: '3%', mem: '412MB' },
    { name: 'vllm', image: 'vllm-openai', state: 'running', cpu: '78%', mem: '96GB' },
    { name: 'orb2-matter', image: 'orb2-matter:dev', state: 'running', cpu: '1%', mem: '120MB' } ] },
  { type: 'home', title: 'Home', devices: [
    { entity_id: 'light.kitchen', name: 'Kitchen lights', domain: 'light', kind: 'Light', state: 'on', on: true, area: 'Kitchen', controllable: true, sub: '80%' },
    { entity_id: 'media_player.living', name: 'Living Room', domain: 'media_player', kind: 'Speaker', state: 'playing', on: true, area: 'Living Room', controllable: false, sub: 'Spotify' },
    { entity_id: 'lock.front', name: 'Front door', domain: 'lock', kind: 'Lock', state: 'locked', on: true, area: 'Entry', controllable: true, sub: '' } ] },
  { type: 'todo', title: 'Working on it', items: [
    { content: 'Read the printer manual', status: 'completed' },
    { content: 'Slice the benchy model', status: 'in_progress' },
    { content: 'Start the print', status: 'pending' } ] },
  { type: 'html', title: 'Custom app', html: '<div style="padding:20px;font-family:system-ui;color:#9c6;background:#0a0f0a;height:100%;"><h2 style="margin:0 0 8px;">Hello from a custom widget</h2><p>Agent-authored HTML renders here.</p></div>' },
  { type: 'document', title: 'Recipe', name: 'carbonara.md', format: 'markdown', text: '# Carbonara\n\n- 200g guanciale\n- 4 eggs\n- Pecorino Romano\n\nCrisp the guanciale. Whisk eggs + cheese. Toss off heat.' },
  { type: 'wallet', title: 'Wallet', methods: [
    { id: 'w1', label: 'Everyday card', brand: 'visa', last4: '4242', kind: 'credit' },
    { id: 'w2', label: 'Groceries', brand: 'amex', last4: '1005', kind: 'credit' } ], selected: 'w1' },
  { type: 'lights', title: 'Lights', groups: [
    { area: 'Kitchen', lights: [ { entity_id: 'light.k1', name: 'Counter', on: true, brightness: 80 }, { entity_id: 'light.k2', name: 'Island', on: false } ] },
    { area: 'Office', lights: [ { entity_id: 'light.o1', name: 'Desk', on: true, brightness: 45 } ] } ] },
  { type: 'media', title: 'Living Room speaker', entity_id: 'media_player.lr', name: 'Living Room', kind: 'speaker', area: 'Living Room', state: 'playing', media_title: 'Kind of Blue — Miles Davis', app: 'Spotify', volume: 32 },
  { type: 'climate', title: 'Thermostat', entity_id: 'climate.main', name: 'Hallway', area: 'Hallway', state: 'cool', current: 76, target: 72 },
  { type: 'shopping', title: 'Shopping list', items: [
    { id: 's1', name: 'Milk', qty: 2, done: false }, { id: 's2', name: 'Coffee beans', done: true }, { id: 's3', name: 'Basil', done: false, note: 'fresh, for pesto' } ] },
  { type: 'vacuum', title: 'Roomba', entity_id: 'vacuum.roomba', area: 'Downstairs', state: 'cleaning', battery: 68, fan: 'turbo' },
  { type: 'covers', title: 'Shades', groups: [ { area: 'Bedroom', covers: [ { entity_id: 'cover.b1', name: 'East window', state: 'open', position: 100 }, { entity_id: 'cover.b2', name: 'West window', state: 'closed', position: 0 } ] } ] },
  { type: 'security', title: 'Security', locks: [ { entity_id: 'lock.front', name: 'Front door', locked: true }, { entity_id: 'lock.back', name: 'Back door', locked: false } ],
    sensors: [ { entity_id: 'binary_sensor.d1', name: 'Front door', kind: 'door', on: false }, { entity_id: 'binary_sensor.m1', name: 'Hallway motion', kind: 'motion', on: true } ] },
  { type: 'plugs', title: 'Plugs', groups: [ { area: 'Office', plugs: [ { entity_id: 'switch.p1', name: '3D printer', on: true }, { entity_id: 'switch.p2', name: 'Monitor', on: false } ] } ] },
  { type: 'scenes', title: 'Scenes', scenes: [ { entity_id: 'scene.movie', name: 'Movie night' }, { entity_id: 'scene.dinner', name: 'Dinner' }, { entity_id: 'scene.goodnight', name: 'Goodnight' } ] },
  { type: 'sensors', title: 'Readings', groups: [ { area: 'Living Room', readings: [ { name: 'Temperature', value: '74.2', unit: '°F' }, { name: 'Humidity', value: '41', unit: '%' } ] },
    { area: 'Garage', readings: [ { name: 'Door', value: 'closed' } ] } ] },
  { type: 'camera', title: 'Front door', name: 'Front door', snapshot: IMG },
  { type: 'timers', title: 'Timers', timers: [ { id: 't-1', label: 'Pasta', at: now + 6 * 60000, set: now - 3 * 60000 }, { id: 't-2', label: 'Laundry', at: now + 42 * 60000, set: now - 3 * 60000 } ] },
  { type: 'presence', title: "Who's home", people: [ { name: 'Martin', home: true }, { name: 'Ana', home: false } ], pill: '1/2 home' },
  { type: 'tv', title: 'Living Room TV', entity_id: 'media_player.tv', name: 'Living Room TV', area: 'Living Room',
    state: 'on', source: 'HDMI 2', sources: ['Live TV', 'HDMI 1', 'HDMI 2', 'Netflix', 'YouTube'], app: 'Netflix', volume: 24 },
  { type: 'spotify', title: 'Spotify', connected: true,
    now: { title: 'Weightless', artist: 'Marconi Union', art: '', playing: true, device: 'Living Room', volume: 45 },
    devices: [ { id: 'd1', name: 'Living Room', type: 'Speaker', active: true }, { id: 'd2', name: 'Kitchen', type: 'Speaker', active: false } ],
    playlists: [ { name: 'Morning Coffee', uri: 'spotify:playlist:x1', tracks: 42, image: '' }, { name: 'Deep Focus', uri: 'spotify:playlist:x2', tracks: 87, image: '' } ] },
  { type: 'ring', title: 'Living Room Ring', entity_id: 'camera.living_room_ring', name: 'Living Room Ring',
    snapshot: '', battery: 74, last_motion: 'now', last_ding: '5:12 PM', siren_entity: 'siren.living_room_ring',
    events: [ { t: Date.now()-3600000, trigger: 'Motion', frame: '' }, { t: Date.now()-7200000, trigger: 'Ding', frame: '' } ] },
  { type: 'house-map', title: 'House', floors: ['Main', 'Upstairs'], rooms: [
    { id: 'living-room', name: 'Living Room', floor: 'Main', x: 0, y: 0, devices: 6, active: true, active_source: 'motion' },
    { id: 'kitchen', name: 'Kitchen', floor: 'Main', x: 3, y: 0, devices: 4, active: false },
    { id: 'office', name: 'Office', floor: 'Upstairs', x: 0, y: 3, devices: 5, active: false } ] },
  { type: 'order', title: 'Sim Eats', state: 'in-progress', service: 'sim-eats', total_cents: 4730, eta: '12 min',
    items: [ { name: 'Pad See Ew', qty: 1, cents: 1450 }, { name: 'Tom Kha (2x)', qty: 1, cents: 3100 } ] },
  { type: 'energy', title: 'Energy', pill: '412 W', total_w: 412, today_kwh: 6.8,
    devices: [ { name: 'Heat pump', area: 'Basement', watts: 220 }, { name: 'Fridge', area: 'Kitchen', watts: 95 }, { name: 'Office desk', area: 'Office', watts: 97 } ] },
  { type: 'automations', title: 'Automations', automations: [ { entity_id: 'automation.night', name: 'Lights off at midnight', on: true, last: '2026-08-19T00:00:00Z' }, { entity_id: 'automation.away', name: 'Away arming', on: false } ] },
  { type: 'printer3d', title: 'Bambu X2D', name: 'Bambu X2D', state: 'printing', progress: 62, layer: 143, total_layers: 231, nozzle: 219, nozzle_target: 220, bed: 55, bed_target: 55, remaining_min: 74, snapshot: IMG, controls: true },
  { type: 'familyboard', title: 'Family board', notes: [ { from: 'Martin', to: 'Ana', text: 'Package on the porch', time: '10:40', delivered: false, trigger: 'home' } ],
    events: [ { date: '2026-08-21', title: 'Dentist — Ana', time: '14:00', who: 'Ana' } ] },
  { type: 'briefing', title: 'Today', briefing: { weather: { temp: 97, condition: 'Sunny', high: 99, low: 76 },
    events: [ { time: '14:00', title: 'Dentist' } ], chores: [ { who: 'Martin', title: 'Trash out' } ],
    security: 'All doors locked', home: ['Martin'], away: ['Ana'], timers: [] } },
  { type: 'housemode', title: 'House mode', mode: 'home' },
  { type: 'setup', title: 'Set up brother', integration: 'brother', flow: { type: 'form', flow_id: 'fx1', handler: 'brother', step_id: 'user',
    step_title: 'Discovered Brother Printer', step_description: 'Do you want to add HL-L2460DW to Home Assistant?',
    fields: [ { name: 'type', type: 'string', required: true, options: ['laser', 'ink'], label: 'Printer type', help: 'The type of the Brother printer.' } ] } },
  { type: 'approval', title: 'Approval needed', approval_id: 'ap-fx', summary: 'Unlock the front door', reason: 'This action is gated — approve it on screen.', offer_always: true, expires_at: Date.now() + 120000 },
  { type: 'receipts', title: 'What Orb did', receipts: [
    { id: 'r-1', ts: Date.now() - 240000, user: 'Martin', summary: 'Set the house to away and secure it', inverse: { kind: 'mode', mode: 'home' } },
    { id: 'r-2', ts: Date.now() - 3600000, user: 'Ana', summary: 'Turn off the kitchen lights', inverse: { kind: 'home-control', entity_id: 'light.k', action: 'on', value: 80 } },
    { id: 'r-3', ts: Date.now() - 7200000, user: 'Martin', summary: 'Announce on Living Room: “Dinner is ready”', undone: false } ] },
  { type: 'deck', title: 'Good morning', cards: [
    { topic: 'calendar', spec: { id: 'dc1', type: 'familyboard', title: 'Today', notes: [], events: [ { date: '2026-08-20', time: '10:00', title: 'Bambu X2D delivery' } ] } },
    { topic: 'house', spec: { id: 'dc2', type: 'note', title: 'Worth a look', text: 'Garage door is open · Motion sensor battery at 12%' } },
    { topic: 'presence', spec: { id: 'dc3', type: 'presence', title: "Who's home", people: [ { name: 'Martin', home: true } ] } } ] },
  { type: 'calculator', title: 'Calculator' },
  { type: 'video', title: 'Launch video', provider: 'file', url: '/assets/icon-192.png' },
  { type: 'music', title: 'Now playing', url: 'about:blank' },
  { type: 'embed', title: 'Embed', url: 'about:blank' },
  { type: 'model', title: '3D model', url: '/does-not-exist.glb' },
];
