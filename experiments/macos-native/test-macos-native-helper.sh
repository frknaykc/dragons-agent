#!/bin/sh
# Explicit macOS lab gate; never installed, packaged or activated. No Node needed.
set -eu
if [ "$(uname -s)" != Darwin ]; then
  printf '%s\n' 'ERROR: native macOS required (not an acceptance skip).' >&2
  exit 1
fi
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
compiler=$(xcrun --find clang)
out=$(mktemp -d "${TMPDIR:-/tmp}/dragons-native-helper.XXXXXX")
trap 'rm -rf -- "$out"' EXIT HUP INT TERM
"$compiler" -std=c11 -Wall -Wextra -Werror -O2 "$root/experiments/macos-native/macos-native-helper-lab.c" -o "$out/helper"
"$compiler" -std=c11 -Wall -Wextra -Werror -O2 "$root/experiments/macos-native/macos-native-helper-lab.test.c" -o "$out/tests"
# Dependency evidence: these two binaries depend only on macOS system libraries.
file "$out/helper" "$out/tests"
otool -L "$out/helper"
"$out/tests" "$out/helper"
