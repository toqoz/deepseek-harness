#!/usr/bin/env bash
# Restart the launchd-managed DSH service so it runs the published generation.
# The generation itself comes from install.sh; this only restarts supervision.
set -euo pipefail

LABEL=${DSH_LAUNCHD_LABEL:-deepseek-harness}

if ! command -v launchctl >/dev/null 2>&1; then
  echo "restart.sh: launchctl is required" >&2
  exit 1
fi

target="gui/$(id -u)/$LABEL"
if ! launchctl print "$target" >/dev/null 2>&1; then
  echo "restart.sh: $target is not loaded; start the service before relying on it" >&2
  exit 1
fi
launchctl kickstart -k "$target"
echo "restarted $target"
