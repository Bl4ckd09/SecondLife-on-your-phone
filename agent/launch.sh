#!/usr/bin/env bash
# Resumable launcher for item_researcher + seller_agent. IDs land in IDS.env.
set -euo pipefail
cd "$(dirname "$0")"

usage() { echo "usage: $0 setup | research ITEM PHOTO_DIR [PROMPT] | sell ITEM [PROMPT] [RUBRIC] | status [SID] | wait [SID] | fetch [SID]" >&2; exit 2; }
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

# jget EXPR: evaluate a python expression over the last response as d
jget() { python3 -c "import json,sys; d=json.JSONDecoder(strict=False).decode(open('$RESP').read()); print($1)"; }

# api BETA METHOD PATH [BODYFILE]: JSON call, fails loudly on non-2xx
api() {
  local beta=$1 method=$2 path=$3 body=${4:-} code
  local args=(-sS -X "$method" "${AUTH[@]}" -H "anthropic-beta: $beta" -H "content-type: application/json" -o "$RESP" -w "%{http_code}")
  [ -n "$body" ] && args+=(--data-binary "@$body")
  code=$(curl "${args[@]}" "$BASE$path")
  if [ "${code:0:1}" != 2 ]; then echo "HTTP $code $method $path" >&2; cat "$RESP" >&2; echo >&2; return 1; fi
}

# memory-store calls use their own beta; fall back to the CMA beta once if rejected
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
  echo "✅ 📦 environment $ENV_ID"
  if [ -z "${MEMSTORE_ID:-}" ]; then
    python3 -c 'import json; print(json.dumps({"name":"reseller-items","description":"Reseller item state. policy.md = seller rules. items/<item_id>/ = dossier.json, research-notes.md, listings.json, thread.md."}))' > runs/tmp/body.json
    mem_api POST /memory_stores runs/tmp/body.json
    save_id MEMSTORE_ID "$(jget "d['id']")"
    python3 -c 'import json; print(json.dumps({"path":"/policy.md","content":open("policy.md").read()}))' > runs/tmp/body.json
    mem_api POST "/memory_stores/$MEMSTORE_ID/memories" runs/tmp/body.json
  fi
  echo "✅ 🧠 memory store $MEMSTORE_ID (policy.md seeded)"
  local role file
  for role in RESEARCHER SELLER; do
    file=agent-$(echo "$role" | tr A-Z a-z).json
    if [ -z "$(eval echo "\${${role}_ID:-}")" ]; then
      python3 -c "import json; a=json.load(open('$file')); a['model']='$MODEL'; print(json.dumps(a))" > runs/tmp/body.json
      api "$CMA_BETA" POST /agents runs/tmp/body.json
      save_id "${role}_ID" "$(jget "d['id']")"
      save_id "${role}_VERSION" "$(jget "d['version']")"
    fi
    eval "echo \"✅ 🤖 agent $file \${${role}_ID} (v\${${role}_VERSION}, $MODEL) $CONSOLE/agents/\${${role}_ID}\""
  done
}

# start_session KIND AGENT_ID AGENT_VERSION ITEM PROMPT RUBRIC [file_id:name ...]
start_session() {
  local kind=$1 aid=$2 aver=$3 item=$4 prompt=$5 rubric=$6; shift 6
  python3 - "$kind" "$aid" "$aver" "$item" "$prompt" "$rubric" "$ENV_ID" "$MEMSTORE_ID" "$@" > runs/tmp/body.json <<'PY'
import json, sys
kind, aid, aver, item, prompt, rubric, env, mem, *files = sys.argv[1:]
res = [{"type": "memory_store", "memory_store_id": mem, "access": "read_write",
        "instructions": "Item state. Items live under items/<item_id>/."}]
for f in files:
    fid, name = f.split(":", 1)
    res.append({"type": "file", "file_id": fid, "mount_path": f"/mnt/session/uploads/{name}"})
print(json.dumps({
    "agent": {"type": "agent", "id": aid, "version": int(aver)},
    "environment_id": env, "title": f"{kind} {item}", "resources": res,
    "initial_events": [{"type": "user.define_outcome",
                        "description": open(prompt).read().replace("item-001", item),
                        "rubric": {"type": "text", "content": open(rubric).read()},
                        "max_iterations": 3}]}))
PY
  api "$CMA_BETA" POST /sessions runs/tmp/body.json
  local sid; sid=$(jget "d['id']")
  save_id LAST_SESSION "$sid"
  printf '%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$kind" "$item" "$sid" >> runs/log.tsv
  echo "✅ ▶️ run started $sid $CONSOLE/sessions/$sid"
}

upload() {
  local code
  code=$(curl -sS -X POST "${AUTH[@]}" -F "file=@$1" -o "$RESP" -w "%{http_code}" "$BASE/files")
  if [ "${code:0:1}" != 2 ]; then
    code=$(curl -sS -X POST "${AUTH[@]}" -H "anthropic-beta: files-api-2025-04-14" -F "file=@$1" -o "$RESP" -w "%{http_code}" "$BASE/files")
    [ "${code:0:1}" = 2 ] || { echo "upload failed HTTP $code: $1" >&2; cat "$RESP" >&2; exit 1; }
  fi
  jget "d['id']"
}

show_status() {
  api "$CMA_BETA" GET "/sessions/$1"
  jget "'status: '+d['status']+'\n'+''.join('outcome: %s | %s\n' % (e.get('result'), (e.get('explanation') or '')[:400]) for e in d.get('outcome_evaluations') or [])+'usage: cost=%s active_s=%s' % ((d.get('usage') or {}).get('list_cost'), (d.get('usage') or {}).get('active_seconds'))"
}

cmd=$1; shift
case $cmd in
  setup) setup ;;
  research)
    [ $# -ge 2 ] || usage
    setup
    item=$1 dir=$2 prompt=${3:-first_prompt-research.txt}; files=()
    for p in "$dir"/*.jpg "$dir"/*.jpeg "$dir"/*.png "$dir"/*.webp; do
      [ -f "$p" ] || continue
      fid=$(upload "$p"); files+=("$fid:$(basename "$p")"); echo "  uploaded $(basename "$p") $fid"
    done
    [ ${#files[@]} -gt 0 ] || { echo "no photos in $dir" >&2; exit 1; }
    start_session research "$RESEARCHER_ID" "$RESEARCHER_VERSION" "$item" "$prompt" outcome-research.md "${files[@]}" ;;
  sell)
    [ $# -ge 1 ] || usage
    setup
    start_session sell "$SELLER_ID" "$SELLER_VERSION" "$1" "${2:-first_prompt-seller.txt}" "${3:-outcome-seller.md}" ;;
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
