#!/bin/sh
# No service installation, production keys, installed .app mutation or activation.
# Ad-hoc cdhash pinning proves real OS sender binding, NOT Developer ID trust.
set -eu
if [ "$(uname -s)" != Darwin ]; then
  printf '%s\n' 'ERROR: native macOS required (not an acceptance skip).' >&2
  exit 1
fi
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
compiler=$(xcrun --find clang)
out=$(mktemp -d "${TMPDIR:-/tmp}/dragons-native-auth.XXXXXX")
trap 'rm -rf -- "$out"' EXIT HUP INT TERM
"$compiler" -std=c11 -Wall -Wextra -Werror -O2 "$root/experiments/macos-native/macos-native-auth-lab.c" -framework Security -framework CoreFoundation -o "$out/helper"
"$compiler" -std=c11 -Wall -Wextra -Werror -O2 "$root/experiments/macos-native/macos-native-auth-lab.test.c" -o "$out/host"
cp "$out/host" "$out/other"
codesign --force --sign - --identifier org.dragons.lab.host "$out/host"
codesign --force --sign - --identifier org.dragons.lab.other "$out/other"
codesign --verify --strict "$out/host"
codesign --verify --strict "$out/other"
# Parse native codesign output without assuming architecture-specific hash size.
hash=$(codesign -d --verbose=4 "$out/host" 2>&1 | /usr/bin/perl -ne 'print $1 if /^CDHash=([0-9a-f]+)$/')
[ -n "$hash" ] || { printf '%s\n' 'ERROR: no host CDHash'; exit 1; }
requirement="cdhash H\"$hash\""
n=0
check() {
  label=$1; sender=$2; policy=$3; mode=$4; expected=$5
  actual=$("$out/helper" --disposable-peer-auth-lab "$sender" "$policy" "$mode")
  if [ "$actual" != "$expected" ]; then
    printf 'not ok - %s: expected %s, got %s\n' "$label" "$expected" "$actual" >&2
    exit 1
  fi
  n=$((n + 1))
  printf 'ok %s - %s: %s\n' "$n" "$label" "$actual"
}
check 'kernel audit sender + pinned ad-hoc code' "$out/host" "$requirement" valid LAB_PEER_AUTHENTICATED_ACTIVATION_UNSUPPORTED
check 'same-user other code denied' "$out/other" "$requirement" valid DENY_IDENTITY
check 'exec-delegated capability does not inherit host identity' "$out/host" "$requirement" "delegate:$out/other" DENY_IDENTITY
check 'wrong requirement denied' "$out/host" 'identifier "org.dragons.lab.nonexistent"' valid DENY_IDENTITY
check 'Developer ID anchor not satisfied by ad-hoc lab' "$out/host" 'anchor apple generic' valid DENY_IDENTITY
check 'malformed requirement denied' "$out/host" 'not a requirement !!!' valid DENY_POLICY
check 'silent sender times out closed' "$out/host" "$requirement" silent DENY_TRANSPORT
for mode in wrong-version activate wrong-id short claimed-team forged-audit reply-port complex oversized; do
  check "$mode denied" "$out/host" "$requirement" "$mode" DENY_SHAPE
done
printf '1..%s\n' "$n"
otool -L "$out/helper"
printf '%s\n' 'Production activation remains unsupported; no Developer ID/Team trust acceptance claimed.'
