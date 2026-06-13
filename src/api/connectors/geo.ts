/**
 * Geocoding + routing for the map widget — free, key-less OpenStreetMap
 * services (Nominatim for place→coords, OSRM for driving routes). Good enough
 * for a single-user self-hosted assistant; swap for a keyed provider at scale.
 */

export interface GeoPoint { lat: number; lng: number; name?: string }

const UA = 'rak00n/1.0 (self-hosted personal assistant)'

/** Place/address → coordinates. null if not found. */
export async function geocode(query: string): Promise<GeoPoint | null> {
  const q = query.trim()
  if (!q) return null
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } })
  if (!r.ok) return null
  const d = (await r.json()) as any[]
  if (!Array.isArray(d) || !d.length) return null
  return { lat: parseFloat(d[0].lat), lng: parseFloat(d[0].lon), name: d[0].display_name }
}

export interface RouteResult { coords: [number, number][]; distanceKm: number; durationMin: number }

/** Driving route through 2+ points → polyline (lat,lng) + distance/duration. */
export async function route(points: GeoPoint[]): Promise<RouteResult | null> {
  if (!points || points.length < 2) return null
  const coordStr = points.map(p => `${p.lng},${p.lat}`).join(';')
  const url = `https://router.project-osrm.org/route/v1/driving/${coordStr}?overview=full&geometries=geojson`
  const r = await fetch(url, { headers: { 'user-agent': UA } })
  if (!r.ok) return null
  const d = (await r.json()) as any
  const rt = d?.routes?.[0]
  if (!rt?.geometry?.coordinates) return null
  // GeoJSON is [lng,lat]; Leaflet wants [lat,lng].
  const coords = rt.geometry.coordinates.map((c: number[]) => [c[1], c[0]] as [number, number])
  return { coords, distanceKm: rt.distance / 1000, durationMin: rt.duration / 60 }
}

// WMO weather codes → human conditions (Open-Meteo uses these).
const WMO: Record<number, string> = {
  0: 'Clear', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Rime fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
  56: 'Freezing drizzle', 57: 'Freezing drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  66: 'Freezing rain', 67: 'Freezing rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow',
  77: 'Snow grains', 80: 'Light showers', 81: 'Showers', 82: 'Violent showers',
  85: 'Snow showers', 86: 'Snow showers', 95: 'Thunderstorm', 96: 'Thunderstorm w/ hail', 99: 'Thunderstorm w/ hail',
}

export interface WeatherResult {
  location: string
  current: { temp: number; condition: string; humidity: number; wind: number }
  forecast: { day: string; high: number; low: number; condition: string }[]
}

/**
 * Current conditions + 5-day forecast for a place name. Geocodes via Nominatim
 * then pulls Open-Meteo (free, key-less). Imperial units. null if not found.
 */
export async function weather(query: string): Promise<WeatherResult | null> {
  const g = await geocode(query)
  if (!g) return null
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${g.lat}&longitude=${g.lng}` +
    `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min&forecast_days=5` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto`
  const r = await fetch(url, { headers: { 'user-agent': UA } })
  if (!r.ok) return null
  const d = (await r.json()) as any
  const c = d?.current
  if (!c) return null
  const days = d?.daily?.time ?? []
  const forecast = days.map((iso: string, i: number) => ({
    day: new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short' }),
    high: Math.round(d.daily.temperature_2m_max[i]),
    low: Math.round(d.daily.temperature_2m_min[i]),
    condition: WMO[d.daily.weather_code[i]] ?? '—',
  }))
  return {
    location: g.name?.split(',').slice(0, 2).join(',').trim() || query,
    current: {
      temp: Math.round(c.temperature_2m),
      condition: WMO[c.weather_code] ?? '—',
      humidity: Math.round(c.relative_humidity_2m),
      wind: Math.round(c.wind_speed_10m),
    },
    forecast,
  }
}
