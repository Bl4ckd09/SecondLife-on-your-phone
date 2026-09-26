import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { RUNS, env, notify } from "./lib.ts";
import { acceptLineGbp, floorGbp } from "./policy.ts";
import { runResearchTool, runSellerTool } from "./tools.ts";

type JsonObject = Record<string, unknown>;
type GrokRow = JsonObject & { id: string; photo_paths?: unknown; dossier?: unknown; ebay?: unknown; vinted?: unknown };

const record = (value: unknown): JsonObject => value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown, max = 5000): string => String(value ?? "").trim().slice(0, max);

function credentials() {
  const url = text(env.SUPABASE_URL, 500).replace(/\/+$/, "");
  const key = text(env.SUPABASE_SERVICE_ROLE_KEY, 5000);
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  return { url, key };
}

async function supabase(path: string, init: RequestInit = {}): Promise<unknown> {
  const { url, key } = credentials();
  const response = await fetch(url + path, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, ...(init.headers as Record<string, string> | undefined) },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Supabase HTTP ${response.status}: ${body.slice(0, 500)}`);
  return body ? JSON.parse(body) : null;
}

async function patchRow(id: string, body: JsonObject, readyOnly = false): Promise<GrokRow[]> {
  const query = new URLSearchParams({ id: `eq.${id}`, ...(readyOnly ? { status: "eq.ready" } : {}) });
  return array(await supabase(`/rest/v1/grok_items?${query}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Prefer: readyOnly ? "return=representation" : "return=minimal" },
    body: JSON.stringify(body),
  })).map((row) => record(row) as GrokRow);
}

async function readyRows(): Promise<GrokRow[]> {
  const query = new URLSearchParams({ select: "*", status: "eq.ready", order: "created_at.asc", limit: "2" });
  return array(await supabase(`/rest/v1/grok_items?${query}`)).map((row) => record(row) as GrokRow);
}

export async function dashboardGrokRows(): Promise<GrokRow[]> {
  const query = new URLSearchParams({ select: "id,status,dossier,ebay,result,bot_notes,created_at", order: "created_at.desc", limit: "50" });
  return array(await supabase(`/rest/v1/grok_items?${query}`)).map((row) => record(row) as GrokRow);
}

function toolRows(value: unknown, action: string): JsonObject[] {
  const error = record(value);
  if (error.error) throw new Error(`${action}: ${text(error.detail || error.error, 500)}`);
  return array(value).map(record);
}

export function mappedCondition(condition: unknown, allowed: JsonObject[]): string {
  const wanted: Record<string, string> = {
    "pre-owned excellent": "PRE_OWNED_EXCELLENT",
    "pre-owned good": "USED_EXCELLENT",
    "pre-owned fair": "PRE_OWNED_FAIR",
    "new with tags": "NEW",
    "new without tags": "NEW_OTHER",
  };
  const enums = allowed.map((entry) => text(entry.enum, 50)).filter(Boolean);
  const mapped = wanted[text(condition, 80).toLowerCase()];
  if (mapped && enums.includes(mapped)) return mapped;
  if (enums[0]) return enums[0];
  throw new Error("condition_policies returned no supported condition enum");
}

async function downloadPhotos(row: GrokRow): Promise<string[]> {
  if (!/^[0-9a-f-]{8,}$/i.test(row.id)) throw new Error("invalid Grok row id");
  const paths = array(row.photo_paths).map((path) => text(path, 500)).filter(Boolean);
  if (!paths.length) throw new Error("row has no photo_paths");
  const archive = join(RUNS, "grok", row.id);
  mkdirSync(archive, { recursive: true });
  const { url, key } = credentials();
  const names: string[] = [];
  for (const [index, path] of paths.entries()) {
    if (path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`invalid photo path: ${path}`);
    const response = await fetch(`${url}/storage/v1/object/intake/${path.split("/").map(encodeURIComponent).join("/")}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!response.ok) throw new Error(`photo ${basename(path)} HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const name = `photo-${index + 1}.jpg`;
    writeFileSync(join(archive, name), Buffer.from(await response.arrayBuffer()));
    names.push(name);
  }
  return names;
}

function writeLocalState(row: GrokRow, item: string, photos: string[], status: "live" | "needs_you", error?: string) {
  const dir = join(RUNS, "intake", item);
  mkdirSync(dir, { recursive: true });
  for (const photo of photos) copyFileSync(join(RUNS, "grok", row.id, photo), join(dir, photo));
  const vinted = record(row.vinted);
  writeFileSync(join(dir, "state.json"), JSON.stringify({
    item,
    status,
    created: new Date().toISOString(),
    facts: { size: text(row.size, 200), condition: text(row.condition, 200), flaws: text(row.flaws, 200) },
    photos,
    fileIds: [],
    title: text(record(row.ebay).title, 80),
    ...(error ? { error } : {}),
    ...(env.VINTED_DISABLED !== "1" ? { vinted: { status: "drafting", listing: vinted } } : {}),
  }, null, 2));
}

function updateLocalState(item: string, values: JsonObject) {
  const path = join(RUNS, "intake", item, "state.json");
  const state = record(JSON.parse(readFileSync(path, "utf8")));
  writeFileSync(path, JSON.stringify({ ...state, ...values }, null, 2));
}

async function processRow(row: GrokRow) {
  const claimed = await patchRow(row.id, { status: "publishing", error: null }, true);
  if (!claimed.length) return;
  row = claimed[0];

  const shortId = row.id.replace(/[^A-Za-z0-9]/g, "").slice(0, 8);
  if (!shortId) throw new Error("invalid Grok row id");
  const item = `grok-${shortId}`;
  const photos = await downloadPhotos(row);
  const dossier = record(row.dossier);
  const ebay = record(row.ebay);
  const ownPhotos = dossier.own_photos === true;
  const vintedResult = env.VINTED_DISABLED === "1" ? "disabled" : "queued";

  writeLocalState(row, item, photos, "needs_you", ownPhotos ? undefined : "eBay skipped: dossier.own_photos is false");
  if (!ownPhotos) {
    const error = "eBay skipped: dossier.own_photos is false";
    await patchRow(row.id, { status: "needs_you", error, result: { ebay: { error }, vinted: vintedResult } });
    return;
  }

  const categoryQuery = text(ebay.category_query, 200);
  if (!categoryQuery) throw new Error("ebay.category_query is missing");
  const categories = toolRows(await runResearchTool(item, { action: "category_suggestions", q: categoryQuery }), "category_suggestions");
  const categoryId = text(categories[0]?.category_id, 30);
  if (!categoryId) throw new Error("category_suggestions returned no category_id");
  const conditions = toolRows(await runResearchTool(item, { action: "condition_policies", category_id: categoryId }), "condition_policies");
  const price = Number(ebay.price_gbp);
  if (!Number.isFinite(price)) throw new Error("ebay.price_gbp is missing or invalid");
  const aspects = Object.fromEntries(Object.entries(record(ebay.aspects)).map(([name, values]) => [name, array(values).map((value) => text(value, 200))]));

  const published = record(await runSellerTool({
    action: "publish_listing",
    item_id: item,
    title: text(ebay.title, 80),
    description: text(ebay.description),
    category_id: categoryId,
    condition: mappedCondition(ebay.condition, conditions),
    aspects,
    price_gbp: price,
    best_offer: { auto_decline_gbp: Math.floor(floorGbp(price)), auto_accept_gbp: acceptLineGbp(price) },
  }));
  if (published.error) {
    const error = `${text(published.error, 80)}: ${text(published.detail, 500)}`;
    updateLocalState(item, { status: "needs_you", error });
    await patchRow(row.id, { status: "failed", error, result: { ebay: { error }, vinted: vintedResult } });
    return;
  }

  const listingId = text(published.listing_id, 120);
  const url = text(published.url, 500);
  if (!listingId || !url) throw new Error("publish_listing returned no listing_id or url");
  updateLocalState(item, { status: "live", error: undefined });
  await patchRow(row.id, { status: "live", error: null, result: { ebay: { listing_id: listingId, url }, vinted: vintedResult } });
  await notify(`Grok path: ${text(ebay.title, 80)} live on eBay £${price}`, url);
}

export async function pollGrokItems() {
  for (const row of await readyRows()) {
    try {
      await processRow(row);
    } catch (error) {
      const message = text(error instanceof Error ? error.message : error, 500);
      console.error(`grok ${row.id}: ${message}`);
      await patchRow(row.id, { status: "failed", error: message, result: { ebay: { error: message }, vinted: env.VINTED_DISABLED === "1" ? "disabled" : "queued" } }).catch((updateError) => {
        console.error(`grok ${row.id} update failed: ${updateError instanceof Error ? updateError.message : updateError}`);
      });
    }
  }
}
