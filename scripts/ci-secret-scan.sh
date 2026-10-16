#!/usr/bin/env bash
set -euo pipefail
scan_tools="$(mktemp -d)"
trap 'rm -rf "$scan_tools"' EXIT
gh release download v8.30.1 --repo gitleaks/gitleaks \
  --pattern gitleaks_8.30.1_linux_x64.tar.gz --dir "$scan_tools"
(
  cd "$scan_tools"
  sha256sum --check <<< '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb  gitleaks_8.30.1_linux_x64.tar.gz'
  tar -xzf gitleaks_8.30.1_linux_x64.tar.gz gitleaks
)
"$scan_tools/gitleaks" git . --redact --no-banner --log-level warn
