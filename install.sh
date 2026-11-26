#!/usr/bin/env bash
set -euo pipefail

UUID="clean-dock@michaeldelrosar.io"
LEGACY_UUID="clean-dock@local.dock"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="${SCRIPT_DIR}/${UUID}"
EXT_BASE="${HOME}/.local/share/gnome-shell/extensions"
DEST_DIR="${EXT_BASE}/${UUID}"

usage() {
    cat <<EOF
Usage: ./install.sh [--uninstall | --pack | --help]

Options:
  (no args)    Install Clean Dock, compile schemas, and migrate legacy UUID if present
  --uninstall  Disable and remove Clean Dock from ~/.local/share/gnome-shell/extensions
  --pack       Build ${UUID}.shell-extension.zip in the repository root
  --help       Show this help message
EOF
}

update_enabled_extensions() {
    local mode="$1"
    python3 - "$mode" "$UUID" "$LEGACY_UUID" <<'PY'
import ast
import subprocess
import sys

mode, uuid, legacy_uuid = sys.argv[1], sys.argv[2], sys.argv[3]
raw = subprocess.check_output(
    ["gsettings", "get", "org.gnome.shell", "enabled-extensions"],
    text=True,
).strip()

if raw.startswith("@as "):
    raw = raw[4:].strip()

exts = list(ast.literal_eval(raw)) if raw else []
changed = False

if legacy_uuid in exts:
    exts = [e for e in exts if e != legacy_uuid]
    changed = True

if mode == "enable":
    if uuid not in exts:
        exts.append(uuid)
        changed = True
elif mode == "disable":
    if uuid in exts:
        exts = [e for e in exts if e != uuid]
        changed = True

if changed:
    subprocess.check_call(
        ["gsettings", "set", "org.gnome.shell", "enabled-extensions", str(exts)]
    )
PY
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    usage
    exit 0
fi

if [[ "${1:-}" == "--uninstall" ]]; then
    gnome-extensions disable "$UUID" 2>/dev/null || true
    update_enabled_extensions disable
    gnome-extensions uninstall "$UUID" 2>/dev/null || rm -rf "$DEST_DIR"
    rm -rf "$DEST_DIR"
    echo "Removed ${UUID} from ${DEST_DIR}."
    exit 0
fi

if [[ "${1:-}" == "--pack" ]]; then
    gnome-extensions pack "$SRC_DIR" \
        --extra-source=dock.js \
        --extra-source=intellihide.js \
        --extra-source=notifications.js \
        --force \
        -o "$SCRIPT_DIR"
    echo "Packed ${SCRIPT_DIR}/${UUID}.shell-extension.zip"
    exit 0
fi

if [[ -n "${1:-}" ]]; then
    echo "Unknown option: $1" >&2
    usage >&2
    exit 1
fi

for cmd in glib-compile-schemas gsettings python3; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "Error: required command '$cmd' not found." >&2
        exit 1
    fi
done

glib-compile-schemas --strict --dry-run "${SRC_DIR}/schemas"

migrated_legacy=0
if [[ -d "${EXT_BASE}/${LEGACY_UUID}" ]]; then
    gnome-extensions disable "$LEGACY_UUID" 2>/dev/null || true
    gnome-extensions uninstall "$LEGACY_UUID" 2>/dev/null || rm -rf "${EXT_BASE}/${LEGACY_UUID}"
    rm -rf "${EXT_BASE}/${LEGACY_UUID}"
    migrated_legacy=1
fi

rm -rf "$DEST_DIR"
mkdir -p "$DEST_DIR"
cp -r "${SRC_DIR}/." "$DEST_DIR/"
glib-compile-schemas "${DEST_DIR}/schemas"

update_enabled_extensions enable
gnome-extensions enable "$UUID" 2>/dev/null || true

echo "Installed ${UUID} to ${DEST_DIR}"
if [[ "$migrated_legacy" -eq 1 ]]; then
    echo "Migrated and removed legacy ${LEGACY_UUID}."
fi
if ! gnome-extensions info "$UUID" >/dev/null 2>&1; then
    echo "Note: On Wayland, log out and log back in once so GNOME Shell loads ${UUID}."
fi
