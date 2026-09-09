#!/usr/bin/env bash
#
# Print the subset of a comma-separated host list that is answering right now.
#
# Usage: live-hosts.sh <url,url,...>
#   stdout: the live URLs, comma-separated, in the input order (may be empty)
#   stderr: one line per dropped host and why
#   exit:   0 always — an empty answer is the caller's decision to make
#
# The probe is protocol-aware rather than a bare "does TCP connect":
#
#   https://…  is a Blossom server, probed with `HEAD <server>/<sha256>` (BUD-01)
#              for a hash no server has. 404 is the healthy answer; any 2xx/3xx/4xx
#              proves the blob endpoint is alive. A 5xx means a reverse proxy is
#              up in front of a backend that is not, which is the common shape of
#              an outage and exactly the one a probe of `/` misses (nginx serves
#              the landing page fine while every /upload 502s).
#   wss://…    is a Nostr relay, probed over HTTPS with a NIP-11 Accept header.
#              Relays without NIP-11 answer 404 or 426; only 5xx or no answer at
#              all counts as down.
#
# A refused connection or a stall past --max-time drops the host either way.
# The probe is a fast filter in front of tools (nsyte, zsp) whose own retry
# loops turn one dead host into a deploy that outlives its deadline; it is not
# a guarantee that the survivors will accept every upload. The callers bound
# and retry for that.
set -euo pipefail

hosts="${1:?usage: live-hosts.sh <url,url,...>}"

# sha256("") — well-formed, and no server stores an empty blob under it.
probe_hash="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

live=""
IFS=, read -r -a list <<<"$hosts"
for url in "${list[@]}"; do
  url="${url#"${url%%[![:space:]]*}"}"
  url="${url%"${url##*[![:space:]]}"}"
  [ -n "$url" ] || continue
  case "$url" in
    ws://*|wss://*)
      probe="$(printf '%s' "$url" | sed -e 's#^wss://#https://#' -e 's#^ws://#http://#')"
      probe="${probe%/}/"
      code="$(curl -sS -o /dev/null -w '%{http_code}' \
                --connect-timeout 5 --max-time 10 \
                -H 'Accept: application/nostr+json' "$probe" 2>/dev/null || true)"
      ;;
    *)
      code="$(curl -sS -o /dev/null -w '%{http_code}' \
                --connect-timeout 5 --max-time 10 \
                -I "${url%/}/$probe_hash" 2>/dev/null || true)"
      ;;
  esac
  case "$code" in
    ""|000)
      echo "  drop (unreachable): $url" >&2
      ;;
    5*)
      echo "  drop (HTTP $code): $url" >&2
      ;;
    *)
      live="${live:+$live,}$url"
      ;;
  esac
done

printf '%s' "$live"
