#!/bin/sh
# Stands in for $SHELL in a terminal session: it says so, with what it was
# given, then waits.
printf 'fake-shell ready: %s\r\n' "$*"
exec sleep 3600
