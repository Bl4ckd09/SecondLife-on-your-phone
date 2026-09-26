// Shared plumbing for worker.ts, pipeline.ts and dashboard.ts: key/ID loading, the CMA REST client,
// the local run log, and downloading a session's output files.
import { readFileSync, existsSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

export const AGENT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const RUNS = join(AGENT_DIR, "runs");
const BASE = "https://api.anthropic.com/v1";
const CMA_BETA = "managed-agents-2026-04-01";
export const MEM_BETA = "agent-memory-2026-07-22";

function readKV(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (line.startsWith("sk-ant-")) out.ANTHROPIC_API_KEY = line; // bare key line
    else if (/^[A-Za-z_]\w*=/.test(line)) out[line.slice(0, line.indexOf("="))] = line.slice(line.indexOf("=") + 1);
  }
  return out;
}

// Later IDS.env lines win, so a bumped SELLER_VERSION overrides the first one. Shell env wins for local settings.
const fromProcess = Object.fromEntries(
  ["INTAKE_SECRET", "NTFY_TOPIC", "WORKSPACE", "EBAY_ENV", "VINTED_DISABLED", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].filter((key) => process.env[key]).map((key) => [key, process.env[key]!]),
);
export const env: Record<string, string> = { ...readKV(join(AGENT_DIR, ".env")), ...readKV(join(AGENT_DIR, "IDS.env")), ...fromProcess };
export const KEY = process.env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY;
if (!KEY) throw new Error("ANTHROPIC_API_KEY missing in agent/.env");
export const CONSOLE = `https://platform.claude.com/workspaces/${env.WORKSPACE || "default"}`;

function headers(beta: string) {
  return { "x-api-key": KEY, "anthropic-version": "2023-06-01", "anthropic-beta": beta, "content-type": "application/json" };
}

export async function apiRaw(method: string, path: string, body?: unknown, beta = CMA_BETA): Promise<Response> {
  const res = await fetch(BASE + path, { method, headers: headers(beta), body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${method} ${path}: ${(await res.text()).slice(0, 500)}`);
  return res;
}

export async function api(method: string, path: string, body?: unknown, beta = CMA_BETA): Promise<any> {
  const text = await (await apiRaw(method, path, body, beta)).text();
  return text ? JSON.parse(text) : {};
}

export type RunEntry = { at: string; kind: string; item: string; session: string };

export function logRun(kind: string, item: string, session: string) {
  mkdirSync(RUNS, { recursive: true });
  appendFileSync(join(RUNS, "log.tsv"), `${new Date().toISOString().slice(0, 19)}Z\t${kind}\t${item}\t${session}\n`);
}

export function readRuns(): RunEntry[] {
  const file = join(RUNS, "log.tsv");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => {
    const [at, kind, item, session] = l.split("\t");
    return { at, kind, item, session };
  });
}

// Download every output file of an idle session into runs/<session>/. Same layout as `launch.sh fetch`.
export async function fetchOutputs(session: string): Promise<string[]> {
  const list = await api("GET", `/files?scope_id=${session}&limit=100`);
  const saved: string[] = [];
  for (const f of list.data ?? []) {
    const rel = normalize(String(f.filename).replace(/^\/+/, "")).replace(/^(\.\.\/)+/, "");
    const dest = join(RUNS, session, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, Buffer.from(await (await apiRaw("GET", `/files/${f.id}/content`)).arrayBuffer()));
    saved.push(rel);
  }
  return saved;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Upload one local file to the Files API. Falls back to the files beta header once, like launch.sh.
export async function uploadFile(path: string): Promise<string> {
  for (const beta of [undefined, "files-api-2025-04-14"]) {
    const form = new FormData();
    form.append("file", new Blob([readFileSync(path)]), basename(path));
    const h: Record<string, string> = { "x-api-key": KEY, "anthropic-version": "2023-06-01" };
    if (beta) h["anthropic-beta"] = beta;
    const res = await fetch(`${BASE}/files`, { method: "POST", headers: h, body: form });
    if (res.ok) return (await res.json()).id;
    if (beta) throw new Error(`upload failed HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  throw new Error("unreachable");
}

export async function deleteFile(id: string) {
  await apiRaw("DELETE", `/files/${id}`).catch(() => undefined); // best effort cleanup
}

// Start a pinned-version session with the memory store, optional photo mounts, and an Outcome kickoff.
export async function startSession(o: {
  kind: string; item: string; agentId: string; agentVersion: string; task: string; rubricFile: string;
  files?: { id: string; name: string }[]; maxIterations?: number;
}): Promise<string> {
  const resources: any[] = [{ type: "memory_store", memory_store_id: env.MEMSTORE_ID, access: "read_write", instructions: "Item state. Items live under items/<item_id>/." }];
  for (const f of o.files ?? []) resources.push({ type: "file", file_id: f.id, mount_path: `/mnt/session/uploads/${f.name}` });
  const s = await api("POST", "/sessions", {
    agent: { type: "agent", id: o.agentId, version: Number(o.agentVersion) },
    environment_id: env.ENV_ID,
    title: `${o.kind} ${o.item}`,
    resources,
    initial_events: [{
      type: "user.define_outcome",
      description: o.task,
      rubric: { type: "text", content: readFileSync(join(AGENT_DIR, o.rubricFile), "utf8") },
      max_iterations: o.maxIterations ?? 3,
    }],
  });
  logRun(o.kind, o.item, s.id);
  return s.id;
}

// Fill {{KEY}} placeholders in one of the agent/ prompt templates.
export function fillTemplate(file: string, vars: Record<string, string>): string {
  return readFileSync(join(AGENT_DIR, file), "utf8").replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "not given");
}

// Push to the phone through ntfy.sh when NTFY_TOPIC is set in agent/.env. Silent otherwise.
export async function notify(title: string, message: string) {
  if (!env.NTFY_TOPIC) return;
  await fetch(`https://ntfy.sh/${encodeURIComponent(env.NTFY_TOPIC)}`, { method: "POST", headers: { Title: title }, body: message }).catch(() => undefined);
}
