/**
 * Shopping / concierge helpers — "where can I buy a lamp?"
 *
 * Two answers, no API keys required:
 *  - online: ready-to-click search links at the big retailers.
 *  - local : nearby shops that sell the thing, via OpenStreetMap's Overpass API
 *            (same OSM data the map widget already uses).
 */

export interface OnlineOption { merchant: string; url: string }

/** Ready-to-click "buy online" links for a search term. */
export function onlineOptions(query: string): OnlineOption[] {
  const q = encodeURIComponent(query.trim())
  return [
    { merchant: 'Amazon', url: `https://www.amazon.com/s?k=${q}` },
    { merchant: 'Google Shopping', url: `https://www.google.com/search?tbm=shop&q=${q}` },
    { merchant: 'Walmart', url: `https://www.walmart.com/search?q=${q}` },
    { merchant: 'eBay', url: `https://www.ebay.com/sch/i.html?_nkw=${q}` },
  ]
}

/** Map a free-text item to the OSM shop categories likely to stock it. */
export function shopTagsFor(query: string): string[] {
  const q = query.toLowerCase()
  const has = (...w: string[]) => w.some(x => q.includes(x))
  if (has('lamp', 'light', 'bulb', 'lighting', 'chandelier')) return ['lighting', 'furniture', 'hardware', 'doityourself', 'department_store']
  if (has('furniture', 'sofa', 'couch', 'table', 'chair', 'desk', 'bed', 'shelf', 'mattress')) return ['furniture', 'department_store']
  if (has('tool', 'drill', 'screw', 'paint', 'hardware', 'nail', 'hammer', 'lumber', 'wood')) return ['hardware', 'doityourself', 'trade']
  if (has('tv', 'laptop', 'computer', 'phone', 'electronic', 'monitor', 'cable', 'charger', 'headphone')) return ['electronics', 'computer', 'mobile_phone', 'department_store']
  if (has('grocery', 'food', 'milk', 'bread', 'coffee', 'snack')) return ['supermarket', 'grocery', 'convenience']
  if (has('clothes', 'shirt', 'shoe', 'jacket', 'dress', 'pants')) return ['clothes', 'shoes', 'department_store']
  if (has('plant', 'garden', 'soil', 'flower')) return ['garden_centre', 'doityourself', 'florist']
  if (has('pharmacy', 'medicine', 'drug', 'prescription')) return ['chemist', 'pharmacy']
  if (has('toy', 'game', 'lego')) return ['toys', 'department_store']
  // Broad retail fallback.
  return ['department_store', 'variety_store', 'supermarket', 'hardware', 'furniture', 'electronics']
}

export interface NearbyStore { name: string; lat: number; lng: number; type: string; distanceKm: number }

function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371, toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng)
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.asin(Math.sqrt(s))
}

/** Find nearby shops (via Overpass) that likely sell `query`, ranked by distance. */
export async function nearbyStores(query: string, lat: number, lng: number, radiusM = 8000): Promise<NearbyStore[]> {
  const tags = shopTagsFor(query)
  const filter = tags.join('|')
  const ql = `[out:json][timeout:20];(` +
    `node["shop"~"^(${filter})$"](around:${radiusM},${lat},${lng});` +
    `way["shop"~"^(${filter})$"](around:${radiusM},${lat},${lng});` +
    `);out center 40;`
  // Overpass nodes are flaky and rate-limited; try a few mirrors with a polite
  // User-Agent (some nodes 406 a UA-less request). First good JSON wins.
  const endpoints = [
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass-api.de/api/interpreter',
    'https://overpass.openstreetmap.fr/api/interpreter',
  ]
  let data: any = null
  for (const ep of endpoints) {
    try {
      const res = await fetch(ep, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': '0rb/1.0 (self-hosted home assistant; https://github.com/MrQbit/0rb)',
          accept: 'application/json',
        },
        body: `data=${encodeURIComponent(ql)}`,
      })
      if (!res.ok) continue
      data = await res.json()
      break
    } catch { /* try next mirror */ }
  }
  if (!data) return []
  const out: NearbyStore[] = []
  for (const el of data?.elements ?? []) {
    const name = el.tags?.name
    if (!name) continue
    const plat = el.lat ?? el.center?.lat
    const plng = el.lon ?? el.center?.lon
    if (plat == null || plng == null) continue
    out.push({
      name,
      lat: plat,
      lng: plng,
      type: el.tags?.shop || 'shop',
      distanceKm: Math.round(haversineKm(lat, lng, plat, plng) * 10) / 10,
    })
  }
  // De-dup by name+rough location, sort by distance, cap.
  const seen = new Set<string>()
  return out
    .filter(s => { const k = `${s.name}@${s.lat.toFixed(3)},${s.lng.toFixed(3)}`; if (seen.has(k)) return false; seen.add(k); return true })
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, 12)
}
