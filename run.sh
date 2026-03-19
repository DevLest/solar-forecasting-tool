#!/usr/bin/env bash
# ARECO Solar Dashboard launcher.
# Works on Linux, macOS, and Windows (Git Bash). Uses system Python if present;
# on Windows, downloads portable Python (one-time) if Python is not installed.

set -e
cd "$(dirname "$0")"
DIR="$(pwd -P 2>/dev/null || pwd)"
PY_EMBED_URL="https://www.python.org/ftp/python/3.12.9/python-3.12.9-embed-amd64.zip"
PY_EMBED_DIR="$DIR/.python"
PY_EMBED_ZIP="$DIR/py_embed.zip"

find_python() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import sys; exit(0 if sys.version_info >= (3, 7) else 1)' 2>/dev/null && echo "python3" && return
  fi
  if command -v python >/dev/null 2>&1; then
    python -c 'import sys; exit(0 if sys.version_info >= (3, 7) else 1)' 2>/dev/null && echo "python" && return
  fi
  if command -v py >/dev/null 2>&1; then
    py -3 -c 'import sys; exit(0 if sys.version_info >= (3, 7) else 1)' 2>/dev/null && echo "py -3" && return
  fi
  if [ -x "$PY_EMBED_DIR/python.exe" ]; then
    echo "$PY_EMBED_DIR/python.exe"
    return
  fi
  echo ""
}

is_windows() {
  case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|CYGWIN*) return 0 ;;
    *) return 1 ;;
  esac
}

download_python_embed() {
  echo "Python not found. Downloading portable Python (one-time, ~25 MB)..."
  if command -v curl >/dev/null 2>&1; then
    curl -sL -o "$PY_EMBED_ZIP" "$PY_EMBED_URL" || true
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$PY_EMBED_ZIP" "$PY_EMBED_URL" || true
  else
    echo "Need curl or wget to download Python. Install Python from https://www.python.org/downloads/ or install Git Bash with curl."
    return 1
  fi
  [ -f "$PY_EMBED_ZIP" ] && [ -s "$PY_EMBED_ZIP" ] || return 1
  mkdir -p "$PY_EMBED_DIR"
  if command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -NoProfile -Command "Expand-Archive -Path '$PY_EMBED_ZIP' -DestinationPath '$PY_EMBED_DIR' -Force"
  elif command -v unzip >/dev/null 2>&1; then
    unzip -q -o "$PY_EMBED_ZIP" -d "$PY_EMBED_DIR"
  else
    echo "Need PowerShell, unzip, or Python to extract. Install Python from https://www.python.org/downloads/"
    rm -f "$PY_EMBED_ZIP"
    return 1
  fi
  rm -f "$PY_EMBED_ZIP"
  # Embed zip may extract with or without a single subfolder
  if [ -x "$PY_EMBED_DIR/python.exe" ]; then
    :
  elif [ -d "$PY_EMBED_DIR/python-3.12.9-embed-amd64" ]; then
    mv "$PY_EMBED_DIR/python-3.12.9-embed-amd64"/* "$PY_EMBED_DIR/"
    rmdir "$PY_EMBED_DIR/python-3.12.9-embed-amd64" 2>/dev/null || true
  fi
  [ -x "$PY_EMBED_DIR/python.exe" ] && return 0
  return 1
}

PY=$(find_python)
if [ -z "$PY" ]; then
  if is_windows; then
    if download_python_embed; then
      PY="$PY_EMBED_DIR/python.exe"
    else
      echo "Could not download Python. Install Python from https://www.python.org/downloads/"
      exit 1
    fi
  else
    echo "Python 3 not found. Install it with:"
    echo "  Ubuntu/Debian: sudo apt install python3"
    echo "  macOS:         xcode-select --install  or  brew install python3"
    echo "  Or download:   https://www.python.org/downloads/"
    exit 1
  fi
fi

echo "Using: $PY"
$PY -m pip install -q -r "$DIR/requirements.txt" 2>/dev/null || true
exec $PY "$DIR/run_dashboard.py"
