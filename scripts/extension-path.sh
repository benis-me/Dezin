#!/usr/bin/env bash
# Print (and, on macOS, copy to the clipboard) the absolute path to the Dezin Capture
# extension, with steps for Chrome's "Load unpacked" dialog — which has no path field,
# but does honor Cmd+Shift+G ("Go to Folder").
set -euo pipefail
DIR="$(cd "$(dirname "$0")/../apps/extension" && pwd)"

if command -v pbcopy >/dev/null 2>&1; then
  printf '%s' "$DIR" | pbcopy
  COPIED="  (path copied to your clipboard)"
else
  COPIED=""
fi

cat <<EOF

Dezin Capture — load the unpacked extension

  Folder: $DIR
$COPIED

  1. Open Chrome → chrome://extensions
  2. Enable "Developer mode" (top-right)
  3. Click "Load unpacked"
  4. In the file dialog press Cmd+Shift+G, paste the path, press Enter
  5. Select the apps/extension folder and open it

Then click the extension icon and confirm the daemon URL (default http://127.0.0.1:7457).
EOF
