#!/bin/sh
set -eu

repo="https://github.com/rckbrcls/sparky-mcp"
case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) echo "Unsupported OS. Use Linux or macOS." >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) echo "Unsupported architecture. Use x64 or arm64." >&2; exit 1 ;;
esac
command -v curl >/dev/null 2>&1 || { echo "curl is required." >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then
  checksum=sha256sum
elif command -v shasum >/dev/null 2>&1; then
  checksum=shasum
else
  echo "sha256sum or shasum is required." >&2
  exit 1
fi

version=${SPARKY_MCP_VERSION:-}
if [ -z "$version" ]; then
  latest=$(curl -fsSL -o /dev/null -w '%{url_effective}' "$repo/releases/latest") || { echo "Cannot resolve the latest release. Check your network." >&2; exit 1; }
  version=${latest##*/}
fi
case "$version" in
  v*) ;;
  *) version="v$version" ;;
esac
case "$version" in
  *[!a-zA-Z0-9._+-]*) echo "Invalid release version." >&2; exit 1 ;;
esac
asset="sparky-mcp-$os-$arch"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
base="$repo/releases/download/$version"
curl -fsSL "$base/$asset" -o "$tmp/$asset" || { echo "Binary download failed. Check release $version and your network." >&2; exit 1; }
curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS" || { echo "Checksum download failed." >&2; exit 1; }
expected=$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1 }' "$tmp/SHA256SUMS")
[ "${#expected}" -eq 64 ] || { echo "Missing or invalid checksum." >&2; exit 1; }
if [ "$checksum" = sha256sum ]; then
  actual=$(sha256sum "$tmp/$asset" | awk '{print $1}')
else
  actual=$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')
fi
[ "$expected" = "$actual" ] || { echo "Checksum mismatch. Installation aborted." >&2; exit 1; }
dir=${SPARKY_MCP_BIN_DIR:-$HOME/.local/bin}
mkdir -p "$dir"
staged=$(mktemp "$dir/.sparky-mcp.XXXXXX")
trap 'rm -rf "$tmp"; rm -f "$staged"' EXIT HUP INT TERM
cp "$tmp/$asset" "$staged"
chmod 755 "$staged"
mv -f "$staged" "$dir/sparky-mcp"
printf 'Installed sparky-mcp %s to %s\n' "$version" "$dir/sparky-mcp"
case ":${PATH:-}:" in
  *":$dir:"*) ;;
  *) printf 'Add %s to your PATH.\n' "$dir" ;;
esac
printf '\nNext step: sparky-mcp init\n'
