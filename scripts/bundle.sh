#!/bin/sh
# Build dist/install.sh: the installer with the program files embedded, so a VPS only needs this one file.
#   npm run bundle   (or: sh scripts/bundle.sh)
set -eu
cd "$(dirname "$0")/.."

ver="$(git describe --always --dirty 2>/dev/null || echo dev) $(date -u +%Y-%m-%d)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/app" dist
cp -R server.js package.json public "$tmp/app/"
printf '%s\n' "$ver" > "$tmp/app/VERSION"
find "$tmp/app" -name '.DS_Store' -delete
# plain ustar: no macOS ._ files or xattr headers that GNU/busybox tar would warn about
if tar --version 2>/dev/null | grep -q bsdtar; then
  COPYFILE_DISABLE=1 tar --format ustar --no-xattrs --no-mac-metadata -czf "$tmp/app.tgz" -C "$tmp" app
else
  tar --format ustar -czf "$tmp/app.tgz" -C "$tmp" app
fi

{
  cat install.sh
  echo '__PAYLOAD_BELOW__'
  base64 < "$tmp/app.tgz" | tr -d '\n' | fold -w 76
  echo
} > dist/install.sh
chmod 755 dist/install.sh
echo "dist/install.sh  ($ver, $(wc -c < dist/install.sh | tr -d ' ') bytes)"
