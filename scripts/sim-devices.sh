#!/usr/bin/env bash
# Install/remove the 0rb simulated device fleet in Home Assistant.
#   scripts/sim-devices.sh on   — install package + restart HA
#   scripts/sim-devices.sh off  — remove package + restart HA
set -euo pipefail
cd "$(dirname "$0")/.."
HA=orb2-homeassistant
case "${1:-on}" in
  on)
    docker exec "$HA" mkdir -p /config/packages
    docker cp services/homeassistant/orb_sim.yaml "$HA":/config/packages/orb_sim.yaml
    docker exec "$HA" sh -c "grep -q 'packages: !include_dir_named packages' /config/configuration.yaml || printf '\nhomeassistant:\n  packages: !include_dir_named packages\n' >> /config/configuration.yaml"
    docker restart "$HA" >/dev/null
    echo "sim fleet installed — HA restarting (entities appear in ~30s)"
    ;;
  off)
    docker exec "$HA" rm -f /config/packages/orb_sim.yaml
    docker restart "$HA" >/dev/null
    echo "sim fleet removed — HA restarting"
    ;;
  *) echo "usage: $0 on|off"; exit 1 ;;
esac
