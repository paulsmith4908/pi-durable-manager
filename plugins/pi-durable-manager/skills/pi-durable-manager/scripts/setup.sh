#!/bin/sh
# Explicit first-use entrypoint. No install hooks, sudo, global packages, or shell profiles.
set -eu
umask 077
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ "$(uname -s)" != Darwin ]; then
  echo 'Pi Durable setup currently supports macOS only.' >&2; exit 1
fi
DATA=${PI_DURABLE_HOME:-"$HOME/Library/Application Support/Pi Durable"}
NODE=''
if command -v node >/dev/null 2>&1; then
  CANDIDATE=$(command -v node)
  if "$CANDIDATE" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)' 2>/dev/null; then NODE=$CANDIDATE; fi
fi
if [ -z "$NODE" ]; then
  VERSION=22.23.4
  case $(uname -m) in
    arm64) ARCH=arm64; HASH=c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428 ;;
    x86_64) ARCH=x64; HASH=efcc2b0db6f94bf53eddb038fe2b370277a042bd29e4f19b8f8e23598795b819 ;;
    *) echo 'Unsupported Mac architecture.' >&2; exit 1 ;;
  esac
  TARGET="$DATA/node/node-v$VERSION-darwin-$ARCH"
  [ ! -L "$DATA" ] && [ ! -L "$DATA/node" ] || { echo 'Refusing a symlinked runtime directory.' >&2; exit 1; }
  mkdir -p "$DATA/node"
  if [ ! -x "$TARGET/bin/node" ]; then
    mkdir "$DATA/node/install.lock" 2>/dev/null || { echo 'Another Node setup may be active. Review the install.lock before retrying.' >&2; exit 1; }
    STAGE=$(mktemp -d "$DATA/node/.stage.XXXXXX")
    trap 'rm -rf "$STAGE"; rmdir "$DATA/node/install.lock"' EXIT
    trap 'exit 130' INT
    trap 'exit 143' HUP TERM
    echo 'Downloading a private Node runtime from nodejs.org; no system installation.' >&2
    /usr/bin/curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --connect-timeout 30 --max-time 600 \
      "https://nodejs.org/dist/v$VERSION/node-v$VERSION-darwin-$ARCH.tar.gz" -o "$STAGE/node.tgz"
    ACTUAL=$(/usr/bin/shasum -a 256 "$STAGE/node.tgz" | /usr/bin/awk '{print $1}')
    [ "$ACTUAL" = "$HASH" ] || { echo 'Node checksum mismatch; refusing installation.' >&2; exit 1; }
    /usr/bin/tar -xzf "$STAGE/node.tgz" -C "$STAGE"
    [ ! -e "$TARGET" ] || { echo 'An incomplete Node installation exists; review it before retrying.' >&2; exit 1; }
    mv "$STAGE/node-v$VERSION-darwin-$ARCH" "$TARGET"
    rm -rf "$STAGE"; rmdir "$DATA/node/install.lock"
    trap - EXIT HUP INT TERM
  fi
  NODE="$TARGET/bin/node"
fi
if [ "${1:-}" = --client ]; then
  shift
  exec "$NODE" "$HERE/pi.mjs" "$@"
fi
exec "$NODE" "$HERE/onboard.mjs" "$@"
