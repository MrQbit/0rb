/**
 * Kill switch — gates chat / file / agent / discovery surfaces from
 * one of two sources:
 *
 *   1. Relay desired state, delivered to us in the heartbeat ACK
 *      payload ('relay-controlled'). When the relay returns
 *      `{ control: { state: 'disabled' } }` rak00n-art flips state
 *      within ~30s. This is what an operator clicks 'Kill all
 *      instances' on the relay dashboard to drive.
 *
 *   2. Local admin override, set via POST /v1/control/{drain,disable,
 *      resume}. Persisted in Redis at `rak00n:control:local_state` so
 *      it survives a router restart and is shared across replicas.
 *      Useful when the relay is unreachable and the operator needs
 *      to take this single instance offline immediately.
 *
 * The effective state is the MOST-RESTRICTIVE of the two:
 *   disabled > draining > active
 *
 * Surfaces consult `getControlState()` on the request hot path. When
 * the effective state is 'disabled' all non-readonly v1 calls return
 * 503 RAK00N_DISABLED. Health/readiness/metrics/info stay open so the
 * pod still passes its probes.
 */
import { log } from '../log.js'
import type { Store } from '../store/store.js'

export type ControlState = 'active' | 'draining' | 'disabled'

export type ControlSnapshot = {
  state: ControlState
  source: 'local' | 'relay' | 'merge'
  reason?: string
  actor?: string
  changedAt: string
}

const KEY_LOCAL = 'rak00n:control:local_state'
const KEY_RELAY = 'rak00n:control:relay_state'

let _store: Store | null = null
let _local: ControlSnapshot = {
  state: 'active',
  source: 'local',
  changedAt: new Date().toISOString(),
}
let _relay: ControlSnapshot = {
  state: 'active',
  source: 'relay',
  changedAt: new Date().toISOString(),
}

function rank(s: ControlState): number {
  return s === 'disabled' ? 2 : s === 'draining' ? 1 : 0
}

export async function initKillSwitch(store: Store): Promise<void> {
  _store = store
  try {
    const raw = await store.getKv(KEY_LOCAL)
    if (raw) _local = { ..._local, ...JSON.parse(raw) }
  } catch {
    // ignore
  }
  try {
    const raw = await store.getKv(KEY_RELAY)
    if (raw) _relay = { ..._relay, ...JSON.parse(raw) }
  } catch {
    // ignore
  }
  // 10s poll keeps replicas in sync without depending on heartbeat
  // timing alone (a router that hasn't beat in the last 30s still
  // refreshes its state every 10s).
  setInterval(() => {
    refresh().catch(() => {})
  }, 10_000)
}

export async function refresh(): Promise<void> {
  if (!_store) return
  try {
    const localRaw = await _store.getKv(KEY_LOCAL)
    if (localRaw) _local = { ..._local, ...JSON.parse(localRaw) }
    const relayRaw = await _store.getKv(KEY_RELAY)
    if (relayRaw) _relay = { ..._relay, ...JSON.parse(relayRaw) }
  } catch {
    // ignore
  }
}

export function getControlState(): ControlSnapshot {
  const effState: ControlState =
    rank(_local.state) >= rank(_relay.state) ? _local.state : _relay.state
  const source: 'local' | 'relay' | 'merge' =
    _local.state === _relay.state
      ? 'merge'
      : rank(_local.state) >= rank(_relay.state)
        ? 'local'
        : 'relay'
  return {
    state: effState,
    source,
    reason: source === 'local' ? _local.reason : _relay.reason,
    actor: source === 'local' ? _local.actor : _relay.actor,
    changedAt: source === 'local' ? _local.changedAt : _relay.changedAt,
  }
}

export function getLocal(): ControlSnapshot {
  return _local
}

export function getRelay(): ControlSnapshot {
  return _relay
}

export async function setLocalState(
  state: ControlState,
  reason?: string,
  actor?: string,
): Promise<ControlSnapshot> {
  _local = {
    state,
    source: 'local',
    reason,
    actor,
    changedAt: new Date().toISOString(),
  }
  if (_store) {
    try {
      await _store.putKv(KEY_LOCAL, JSON.stringify(_local), 0)
    } catch (err) {
      log.warn('control_local_persist_failed', {
        error: (err as Error).message,
      })
    }
  }
  return _local
}

/**
 * Called by the relay reporter on every heartbeat ACK. Persisted in
 * Redis (TTL 5 minutes) so a router that just booted gets the relay
 * state without waiting for its first heartbeat.
 */
export async function setRelayState(
  state: ControlState,
  reason?: string,
  actor?: string,
): Promise<ControlSnapshot> {
  if (state === _relay.state && reason === _relay.reason) return _relay
  _relay = {
    state,
    source: 'relay',
    reason,
    actor,
    changedAt: new Date().toISOString(),
  }
  if (_store) {
    try {
      await _store.putKv(KEY_RELAY, JSON.stringify(_relay), 300)
    } catch (err) {
      log.warn('control_relay_persist_failed', {
        error: (err as Error).message,
      })
    }
  }
  return _relay
}
