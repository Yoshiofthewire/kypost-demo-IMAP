#!/bin/sh
# Acceptance suite: drives the demo server with the real IMAP client library
# KyPost Server uses, plus net/smtp and net/http. Starts and stops the server
# itself on high ports; nothing else needs to be running.
#
# Needs node and go on PATH. Uses the local module cache so it works offline.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

node --test "$ROOT"/test/unit/*.test.js

cd "$ROOT/test/acceptance"

GOMODCACHE="$(go env GOMODCACHE)"
export GOFLAGS=-mod=mod
export GOPROXY="file://${GOMODCACHE}/cache/download"
export GOSUMDB=off

exec go test ./... -count=1 "$@"
