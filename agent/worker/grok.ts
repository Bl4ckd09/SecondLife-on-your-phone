import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { RUNS, env, notify } from "./lib.ts";
import { acceptLineGbp, floorGbp } from "./policy.ts";
import { delivered, runResearchTool, runSellerTool } from "./tools.ts";

type JsonObject = Record<string, unknown>;
type GrokRow = JsonObject & { id: string; photo_paths?: unknown; dossier?: unknown; ebay?: unknown; vinted?: unknown; result?: unknown };

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

type StatusColumn = "ebay_status" | "vinted_status";

async function patchRow(id: string, body: JsonObject, expected?: [StatusColumn, string]): Promise<GrokRow[]> {
  const query = new URLSearchParams({ id: `eq.${id}` });
  if (expected) query.set(expected[0], `eq.${expected[1]}`);
  return array(await supabase(`/rest/v1/grok_items?${query}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Prefer: expected ? "return=representation" : "return=minimal" },
    body: JSON.stringify(body),
  })).map((row) => record(row) as GrokRow);
}

async function itemRows(column: StatusColumn, status: string, limit: number): Promise<GrokRow[]> {
  const query = new URLSearchParams({ select: "*", [column]: `eq.${status}`, order: "created_at.asc", limit: String(limit) });
  return array(await supabase(`/rest/v1/grok_items?${query}`)).map((row) => record(row) as GrokRow);
}

export async function dashboardGrokData() {
  const [items, inbox, inboxStatuses, vintedStatuses] = await Promise.all([
    supabase(`/rest/v1/grok_items?${new URLSearchParams({ select: "id,status,ebay_status,vinted_status,dossier,ebay,vinted,result,bot_notes,created_at", order: "created_at.desc", limit: "50" })}`),
    supabase(`/rest/v1/grok_inbox?${new URLSearchParams({ select: "id,kind,buyer,text,amount_gbp,status,response,created_at", order: "created_at.desc", limit: "5" })}`),
    supabase(`/rest/v1/grok_inbox?${new URLSearchParams({ select: "status" })}`),
    supabase(`/rest/v1/grok_vinted_messages?${new URLSearchParams({ select: "status" })}`),
  ]);
  return {
    items: array(items).map((row) => record(row) as GrokRow),
    inbox: array(inbox).map(record),
    inboxStatuses: array(inboxStatuses).map(record),
    vintedStatuses: array(vintedStatuses).map(record),
  };
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
  const names: string[] = [];
  for (const [index, path] of paths.entries()) {
    if (path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`invalid photo path: ${path}`);
    const name = `photo-${index + 1}.jpg`;
    const local = join(archive, name);
    if (!existsSync(local)) {
      const { url, key } = credentials();
      const response = await fetch(`${url}/storage/v1/object/intake/${path.split("/").map(encodeURIComponent).join("/")}`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      });
      if (!response.ok) throw new Error(`photo ${basename(path)} HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      writeFileSync(local, Buffer.from(await response.arrayBuffer()));
    }
    names.push(name);
  }
  return names;
}

function itemName(row: GrokRow): string {
  const shortId = row.id.replace(/[^A-Za-z0-9]/g, "").slice(0, 8);
  if (!shortId) throw new Error("invalid Grok row id");
  return `grok-${shortId}`;
}

function localStatePath(item: string): string {
  if (!/^grok-[A-Za-z0-9]+$/.test(item)) throw new Error("invalid Grok item id");
  return join(RUNS, "intake", item, "state.json");
}

function saveLocalState(path: string, state: JsonObject) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2));
  renameSync(temporary, path);
}

function ensureLocalState(row: GrokRow, item: string, photos: string[], values: JsonObject = {}) {
  const dir = join(RUNS, "intake", item);
  mkdirSync(dir, { recursive: true });
  for (const photo of photos) {
    const destination = join(dir, photo);
    if (!existsSync(destination)) copyFileSync(join(RUNS, "grok", row.id, photo), destination);
  }
  const path = localStatePath(item);
  const current = existsSync(path) ? record(JSON.parse(readFileSync(path, "utf8"))) : {};
  if (current.grokRowId && current.grokRowId !== row.id) throw new Error(`${item} belongs to another Grok row`);
  saveLocalState(path, {
    status: "needs_you",
    created: new Date().toISOString(),
    fileIds: [],
    title: text(record(row.ebay).title, 80),
    ...current,
    item,
    grokRowId: row.id,
    facts: { size: text(row.size, 200), condition: text(row.condition, 200), flaws: text(row.flaws, 200) },
    photos,
    ...values,
  });
}

function updateLocalState(item: string, values: JsonObject) {
  const path = localStatePath(item);
  const state = record(JSON.parse(readFileSync(path, "utf8")));
  saveLocalState(path, { ...state, ...values });
}

const resultWith = (row: GrokRow, channel: "ebay" | "vinted", value: unknown) => ({ ...record(row.result), [channel]: value });

async function processEbayRow(row: GrokRow) {
  const claimed = await patchRow(row.id, { ebay_status: "publishing" }, ["ebay_status", "ready"]);
  if (!claimed.length) return;
  row = claimed[0];

  const item = itemName(row);
  const photos = await downloadPhotos(row);
  const dossier = record(row.dossier);
  const ebay = record(row.ebay);
  ensureLocalState(row, item, photos);

  if (dossier.own_photos !== true) {
    const error = "eBay skipped: dossier.own_photos is false";
    updateLocalState(item, { status: "needs_you", error });
    await patchRow(row.id, { ebay_status: "needs_you", error, result: resultWith(row, "ebay", { error }) }, ["ebay_status", "publishing"]);
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
    const status = published.error === "policy" ? "needs_you" : "failed";
    updateLocalState(item, { status, error });
    await patchRow(row.id, { ebay_status: status, error, result: resultWith(row, "ebay", { error }) }, ["ebay_status", "publishing"]);
    return;
  }

  const listingId = text(published.listing_id, 120);
  const url = text(published.url, 500);
  if (!listingId || !url) throw new Error("publish_listing returned no listing_id or url");
  updateLocalState(item, { status: "live", error: undefined });
  await patchRow(row.id, { ebay_status: "live", result: resultWith(row, "ebay", { listing_id: listingId, url }) }, ["ebay_status", "publishing"]);
  await notify(`Grok path: ${text(ebay.title, 80)} live on eBay £${price}`, url);
}

async function processVintedRow(row: GrokRow) {
  const claimed = await patchRow(row.id, { vinted_status: "drafting" }, ["vinted_status", "ready"]);
  if (!claimed.length) return;
  row = claimed[0];
  if (env.VINTED_DISABLED === "1") throw new Error("Vinted drafting is disabled");
  const item = itemName(row);
  const photos = await downloadPhotos(row);
  ensureLocalState(row, item, photos, { vinted: { status: "drafting", listing: record(row.vinted) } });
}

async function syncVintedStatus(row: GrokRow) {
  const item = itemName(row);
  const path = localStatePath(item);
  if (!existsSync(path)) throw new Error(`local state is missing for ${item}`);
  const local = record(JSON.parse(readFileSync(path, "utf8")));
  if (local.grokRowId !== row.id) throw new Error(`local state does not match Grok row ${row.id}`);
  const vinted = record(local.vinted);
  const localStatus = text(vinted.status, 40);
  if (localStatus === "drafted") {
    const updated = await patchRow(row.id, { vinted_status: "drafted" }, ["vinted_status", "drafting"]);
    if (updated.length) {
      const listing = record(row.vinted);
      await notify(`Grok Vinted draft ready: ${text(listing.title, 80)}`, `£${text(listing.price_gbp, 20)} · Open Vinted ▸ Drafts.`);
    }
  } else if (localStatus === "failed" || localStatus === "skipped") {
    const error = text(vinted.error || `Vinted drafting ${localStatus}`, 500);
    await patchRow(row.id, { vinted_status: "failed", error, result: resultWith(row, "vinted", { error }) }, ["vinted_status", "drafting"]);
  }
}

async function failChannel(row: GrokRow, column: StatusColumn, expected: string, error: unknown) {
  const message = text(error instanceof Error ? error.message : error, 500);
  console.error(`grok ${row.id} ${column}: ${message}`);
  const channel = column === "ebay_status" ? "ebay" : "vinted";
  await patchRow(row.id, { [column]: "failed", error: message, result: resultWith(row, channel, { error: message }) }, [column, expected]).catch((updateError) => {
    console.error(`grok ${row.id} update failed: ${updateError instanceof Error ? updateError.message : updateError}`);
  });
}

export async function pollGrokItems() {
  for (const row of await itemRows("ebay_status", "ready", 2)) {
    try { await processEbayRow(row); } catch (error) { await failChannel(row, "ebay_status", "publishing", error); }
  }
  for (const row of await itemRows("vinted_status", "ready", 2)) {
    try { await processVintedRow(row); } catch (error) { await failChannel(row, "vinted_status", "drafting", error); }
  }
  for (const row of await itemRows("vinted_status", "drafting", 50)) {
    try { await syncVintedStatus(row); } catch (error) { await failChannel(row, "vinted_status", "drafting", error); }
  }
}

type BridgeTable = "grok_inbox" | "grok_vinted_messages";

async function insertIgnore(table: BridgeTable, conflict: string, body: JsonObject) {
  await supabase(`/rest/v1/${table}?${new URLSearchParams({ on_conflict: conflict })}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify(body),
  });
}

async function bridgeRows(table: BridgeTable, status: string): Promise<JsonObject[]> {
  const query = new URLSearchParams({ select: "*", status: `eq.${status}`, order: "created_at.asc", limit: "20" });
  return array(await supabase(`/rest/v1/${table}?${query}`)).map(record);
}

async function patchBridge(table: BridgeTable, id: unknown, status: string, body: JsonObject) {
  const query = new URLSearchParams({ id: `eq.${text(id, 100)}`, status: `eq.${status}` });
  await supabase(`/rest/v1/${table}?${query}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
}

function grokRowId(item: string): string {
  const state = record(JSON.parse(readFileSync(localStatePath(item), "utf8")));
  const id = text(state.grokRowId, 100);
  if (!/^[0-9a-f-]{8,}$/i.test(id)) throw new Error(`${item} has no grokRowId`);
  return id;
}

const numberOrNull = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : null;

async function pullGrokInbox(inbox: JsonObject) {
  for (const [kind, entries] of [["question", array(inbox.questions)], ["offer", array(inbox.offers)]] as const) {
    for (const value of entries) {
      const entry = record(value);
      const item = text(entry.item_id, 100);
      if (!item.startsWith("grok-")) continue;
      const ebayRef = text(kind === "question" ? entry.message_id : entry.offer_id, 120);
      if (!ebayRef) continue;
      delivered.delete(ebayRef);
      await insertIgnore("grok_inbox", "ebay_ref", {
        kind,
        ebay_ref: ebayRef,
        item_id: grokRowId(item),
        listing_id: text(entry.listing_id, 120),
        buyer: text(entry.buyer, 100),
        text: text(kind === "question" ? entry.text : entry.message, 2000),
        amount_gbp: kind === "offer" ? numberOrNull(entry.amount_gbp) : null,
        listed_gbp: numberOrNull(entry.listed_gbp),
        floor_gbp: numberOrNull(entry.floor_gbp),
      });
    }
  }
}

export function grokSellerAction(value: unknown): JsonObject {
  const row = record(value);
  const response = record(row.response);
  const action = text(response.action, 20);
  const ebayRef = text(row.ebay_ref, 120);
  if (!ebayRef) throw new Error("policy: ebay_ref is missing");
  if (row.kind === "question") {
    const reply = text(response.text, 2000);
    if (action !== "reply" || !reply) throw new Error("policy: a question requires a reply with text");
    return { action: "reply", message_id: ebayRef, text: reply };
  }
  if (row.kind !== "offer" || !["accept", "counter", "decline"].includes(action)) {
    throw new Error("policy: an offer requires accept, counter, or decline");
  }
  const listingId = text(row.listing_id, 120);
  if (!listingId) throw new Error("policy: listing_id is missing");
  const input: JsonObject = { action: "respond_offer", offer_id: ebayRef, listing_id: listingId, decision: action };
  const reply = text(response.text, 2000);
  if (reply) input.text = reply;
  if (action === "counter") {
    const counter = Number(response.counter_gbp);
    if (!Number.isFinite(counter)) throw new Error("policy: counter_gbp is missing");
    input.counter_gbp = counter;
  }
  return input;
}

async function executeGrokInbox() {
  for (const row of await bridgeRows("grok_inbox", "answered")) {
    try {
      const result = record(await runSellerTool(grokSellerAction(row)));
      if (result.error) {
        const message = `${text(result.error, 80)}: ${text(result.detail, 500)}`;
        const status = result.error === "policy" ? "needs_you" : "failed";
        await patchBridge("grok_inbox", row.id, "answered", { status, result: { error: message } });
        if (status === "needs_you") await notify("Grok eBay inbox needs you", message);
      } else {
        await patchBridge("grok_inbox", row.id, "answered", { status: "sent", result });
      }
    } catch (error) {
      const message = text(error instanceof Error ? error.message : error, 500);
      const status = message.startsWith("policy:") ? "needs_you" : "failed";
      await patchBridge("grok_inbox", row.id, "answered", { status, result: { error: message } });
      if (status === "needs_you") await notify("Grok eBay inbox needs you", message);
    }
  }
}

export async function syncGrokInbox() {
  const inbox = record(await runSellerTool({ action: "get_inbox" }));
  if (inbox.error) throw new Error(`${text(inbox.error, 80)}: ${text(inbox.detail, 500)}`);
  await pullGrokInbox(inbox);
  await executeGrokInbox();
}

export async function syncGrokVintedNotification(notification: {
  uid: number;
  buyer: string;
  listing: string;
  message: string;
  offer_gbp?: number;
}) {
  await insertIgnore("grok_vinted_messages", "mail_uid", {
    mail_uid: String(notification.uid),
    buyer: notification.buyer,
    listing: notification.listing,
    message: notification.message,
    offer_gbp: notification.offer_gbp ?? null,
  });
}

export async function pushGrokVintedSuggestions() {
  for (const row of await bridgeRows("grok_vinted_messages", "suggested")) {
    const reply = text(record(row.suggestion).suggested_reply, 2000);
    if (!reply) {
      console.error(`grok Vinted message ${text(row.id, 100)} has no suggested_reply`);
      await patchBridge("grok_vinted_messages", row.id, "suggested", { status: "failed" });
      continue;
    }
    await notify(`Grok suggests for ${text(row.buyer, 80)}`, reply);
    await patchBridge("grok_vinted_messages", row.id, "suggested", { status: "pushed" });
  }
}
