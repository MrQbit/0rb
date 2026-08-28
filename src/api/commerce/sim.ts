/**
 * Sim-commerce harness (SPEC Part V, skeleton — fleshed out with the
 * connector framework in Stage 2): deterministic stores, menus, prices,
 * couriers and trips, plus fixture mail, so every commerce flow is
 * provable without a real dollar moving. Enabled only when
 * ORB2_SIM_COMMERCE=1 — never in a clean production install.
 */
export function simCommerceEnabled(): boolean {
  return process.env.ORB2_SIM_COMMERCE === '1'
}

export const SIM_CATALOG = {
  'sim-eats': {
    label: 'Sim Eats', category: 'food' as const,
    menu: [
      { id: 'thai-1', name: 'Pad See Ew', cents: 1450 },
      { id: 'thai-2', name: 'Larb Moo', cents: 1250 },
      { id: 'poke-1', name: 'Salmon Poke Bowl', cents: 1600 },
      { id: 'soup-1', name: 'Tom Kha (2x)', cents: 3100 },
    ],
    etaMinutes: 25,
  },
  'sim-store': {
    label: 'Sim Store', category: 'consumables' as const,
    menu: [
      { id: 'petg-1', name: 'PETG Filament 1kg — Matte Black', cents: 2400 },
      { id: 'res-10k', name: '10k Resistor Kit (100)', cents: 899 },
      { id: 'coffee-1', name: 'Coffee Beans 1kg', cents: 1850 },
      { id: 'batt-cr2', name: 'CR2032 4-pack', cents: 650 },
    ],
    etaMinutes: 2880,
  },
  'sim-rides': {
    label: 'Sim Rides', category: 'rides' as const,
    menu: [{ id: 'ride-std', name: 'Standard ride', cents: 1400 }],
    etaMinutes: 4,
  },
} as const
