#!/usr/bin/env bash
# Resumable setup and inspection for the five sales agents.
set -euo pipefail
cd "$(dirname "$0")"

usage() { echo "usage: $0 setup | status [SID] | wait [SID] | fetch [SID]" >&2; exit 2; }
[ $# -ge 1 ] || usage

# .env lines are KEY=VALUE; a bare sk-ant-... line is taken as the API key
if [ -f .env ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    case $line in
      sk-ant-*) export ANTHROPIC_API_KEY=$line ;;
      [A-Za-z_]*=*) export "${line%%=*}=${line#*=}" ;;
    esac
  done < .env
fi
[ -n "${ANTHROPIC_API_KEY:-}" ] || { echo "ANTHROPIC_API_KEY missing (put it in .env)" >&2; exit 1; }
touch IDS.env; set -a; . ./IDS.env; set +a
mkdir -p runs/tmp

BASE=https://api.anthropic.com/v1
WS=${WORKSPACE:-default}
CONSOLE="https://platform.claude.com/workspaces/$WS"
AUTH=(-H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01")
CMA_BETA=managed-agents-2026-04-01
MEM_BETA=agent-memory-2026-07-22
RESP=runs/tmp/resp.json

save_id() { echo "$1=$2" >> IDS.env; export "$1=$2"; }
jget() { python3 -c "import json; d=json.JSONDecoder(strict=False).decode(open('$RESP').read()); print($1)"; }

api() {
  local beta=$1 method=$2 path=$3 body=${4:-} code
  local args=(-sS -X "$method" "${AUTH[@]}" -H "anthropic-beta: $beta" -H "content-type: application/json" -o "$RESP" -w "%{http_code}")
  [ -n "$body" ] && args+=(--data-binary "@$body")
  code=$(curl "${args[@]}" "$BASE$path")
  if [ "${code:0:1}" != 2 ]; then echo "HTTP $code $method $path" >&2; cat "$RESP" >&2; echo >&2; return 1; fi
}

mem_api() { api "$MEM_BETA" "$@" 2>runs/tmp/mem.err || { grep -qi beta runs/tmp/mem.err && api "$CMA_BETA" "$@"; } || { cat runs/tmp/mem.err >&2; return 1; }; }

setup() {
  if [ -z "${MODEL:-}" ]; then
    api "$CMA_BETA" GET "/models?limit=100"
    save_id MODEL "$(jget "sorted([m for m in d['data'] if 'opus' in m['id']], key=lambda m: m.get('created_at',''), reverse=True)[0]['id']")"
  fi
  if [ -z "${ENV_ID:-}" ]; then
    api "$CMA_BETA" POST /environments environment.json
    save_id ENV_ID "$(jget "d['id']")"
  fi
  echo "environment $ENV_ID"
  if [ -z "${MEMSTORE_ID:-}" ]; then
    python3 -c 'import json; print(json.dumps({"name":"ebay-items","description":"eBay item state. policy.md = seller rules. items/<item_id>/ = dossier.json, research-notes.md, listing.json, thread.md."}))' > runs/tmp/body.json
    mem_api POST /memory_stores runs/tmp/body.json
    save_id MEMSTORE_ID "$(jget "d['id']")"
    python3 -c 'import json; print(json.dumps({"path":"/policy.md","content":open("policy.md").read()}))' > runs/tmp/body.json
    mem_api POST "/memory_stores/$MEMSTORE_ID/memories" runs/tmp/body.json
  fi
  echo "memory store $MEMSTORE_ID (policy.md seeded)"
  local role file id_key version_key id version
  while read -r role file; do
    id_key=${role}_ID
    version_key=${role}_VERSION
    id=${!id_key:-}
    version=${!version_key:-}
    if [ -z "$id" ]; then
      python3 -c "import json; a=json.load(open('$file')); a['model']='$MODEL'; print(json.dumps(a))" > runs/tmp/body.json
      api "$CMA_BETA" POST /agents runs/tmp/body.json
      id=$(jget "d['id']")
      version=$(jget "d['version']")
      save_id "$id_key" "$id"
      save_id "$version_key" "$version"
    fi
    echo "agent $file $id (v$version, $MODEL) $CONSOLE/agents/$id"
  done <<'ROLES'
RESEARCHER agent-researcher.json
EBAY_POSTER agent-ebay-poster.json
VINTED agent-vinted.json
EBAY_BUYER agent-ebay-buyer.json
VINTED_REPLY agent-vinted-reply.json
ROLES
  echo "Research, eBay listing, Vinted drafting, and inbox tools require: cd worker && npx tsx worker.ts watch"
}

show_status() {
  api "$CMA_BETA" GET "/sessions/$1"
  jget "'status: '+d['status']+'\n'+''.join('outcome: %s | %s\n' % (e.get('result'), (e.get('explanation') or '')[:400]) for e in d.get('outcome_evaluations') or [])+'usage: cost=%s active_s=%s' % ((d.get('usage') or {}).get('list_cost'), (d.get('usage') or {}).get('active_seconds'))"
}

cmd=$1; shift
case $cmd in
  setup) setup ;;
  status) show_status "${1:-$LAST_SESSION}" ;;
  wait)
    sid=${1:-$LAST_SESSION}; seen=0
    for _ in $(seq 1 135); do
      api "$CMA_BETA" GET "/sessions/$sid"
      st=$(jget "d['status']"); ev=$(jget "(d.get('outcome_evaluations') or [{}])[-1].get('result','-')")
      echo "$(date +%T) $st $ev"
      [ "$st" != idle ] && seen=1
      { [ "$st" = terminated ] || { [ "$st" = idle ] && { [ $seen = 1 ] || [ "$ev" != - ]; }; }; } && break
      sleep 20
    done
    show_status "$sid" ;;
  fetch)
    sid=${1:-$LAST_SESSION}; out=runs/$sid; mkdir -p "$out"
    api "$CMA_BETA" GET "/files?scope_id=$sid&limit=100"
    jget "'\n'.join(f['id']+'\t'+f['filename'] for f in d['data'])" | while IFS=$'\t' read -r fid name; do
      [ -n "$fid" ] || continue
      name=${name#/}; name=${name//..\//}; mkdir -p "$out/$(dirname "$name")"
      curl -sS "${AUTH[@]}" -H "anthropic-beta: $CMA_BETA" -o "$out/$name" "$BASE/files/$fid/content"
      echo "  $out/$name"
    done ;;
  *) usage ;;
esac
