/**
 * Real-service connectors (SPEC §5/§6, Stage 4 fills these): handoff is
 * always the floor — deep-linked, human-paid, mail-watched. Registered
 * here as they land; empty list is valid.
 */
import type { ServiceConnector } from './connector.js'

export function realConnectors(): ServiceConnector[] {
  return []
}
