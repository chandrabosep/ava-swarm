#!/usr/bin/env bash
# Dump every form of help/flag info the AXL binary supports, so we can
# see whether there's an undocumented way to remap the HTTP API port
# (currently believed to be hardcoded to 9002).

set +e
BIN="${AXL_BIN:-$HOME/shiva/axl/node}"
echo "=== bin: $BIN ==="
file "$BIN" 2>/dev/null
echo

for flag in --help -h -help; do
  echo "=== $BIN $flag ==="
  "$BIN" $flag 2>&1 | head -80
  echo
done

# Look for env vars referenced inside the binary
echo "=== strings in binary mentioning 'PORT', 'API', 'HTTP', 'LISTEN' ==="
strings "$BIN" 2>/dev/null \
  | grep -iE '^(api|http|listen|port|axl_)[a-z_]*$|HTTP.*PORT|API.*PORT' \
  | sort -u | head -40
echo

echo "=== strings mentioning 9002 (current hardcoded port) ==="
strings "$BIN" 2>/dev/null | grep -E '9002' | head -10
