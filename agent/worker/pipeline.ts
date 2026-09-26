// Photo intake → eBay research → publish, plus buyer inbox handling.
import { timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { z } from "zod/v4";
import { MEM_BETA, RUNS, api, deleteFile, env, fetchOutputs, fillTemplate, notify, sleep, startSession, uploadFile } from "./lib.ts";
import { delivered, runResearchTool, runSellerTool } from "./tools.ts";
import { blockedReason, humanPause, openBrowser, type Hands } from "./browser.ts";

const INTAKE = join(RUNS, "intake");
const SEEN_FILE = join(RUNS, "ebay-seen.json");
const PORT = Number(process.env.INTAKE_PORT ?? 4747);
const MAX_PHOTOS = 8;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const POLL_MS = 15_000;
const INTAKE_ITERATIONS = 1;
const INBOX_MS = Math.max(1, Number(process.env.EBAY_INBOX_MINUTES ?? env.EBAY_INBOX_MINUTES ?? 10)) * 60_000;
const Status = z.enum(["new", "researching", "listing", "live", "needs_you", "failed"]);
const PriceHint = z.object({
  bargain: z.number().nullable(),
  optimal: z.number().nullable(),
  premium: z.number().nullable(),
});
const VintedState = z.object({
  status: z.enum(["listing", "drafting", "drafted", "failed", "skipped"]),
  session: z.string().optional(),
  listing: z.record(z.string(), z.unknown()).optional(),
  skippedFields: z.array(z.string()).optional(),
  priceHint: PriceHint.optional(),
  error: z.string().optional(),
  attempts: z.number().optional(),
}).loose();
const ItemState = z.object({
  item: z.string(),
  status: Status,
  created: z.string(),
  facts: z.object({ size: z.string(), condition: z.string(), flaws: z.string() }),
  photos: z.array(z.string()),
  fileIds: z.array(z.string()),
  title: z.string().optional(),
  researchSession: z.string().optional(),
  listingSession: z.string().optional(),
  listingId: z.string().optional(),
  listedGbp: z.number().optional(),
  url: z.string().optional(),
  error: z.string().optional(),
  attempts: z.number().optional(),
  vinted: VintedState.optional(),
}).loose();

type ItemState = z.infer<typeof ItemState>;
type PriceHint = z.infer<typeof PriceHint>;
type DraftResult = { skipped: string[]; hint: PriceHint | null };
export type ToolScope =
  | { kind: "research" | "listing" | "vinted"; item: string }
  | { kind: "inbox" | "none" };
type Settlement = { status: string; verdict: string };

const stateFile = (item: string) => join(INTAKE, item, "state.json");

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function array(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function load(item: string): ItemState {
  return ItemState.parse(JSON.parse(readFileSync(stateFile(item), "utf8")));
}

function save(state: ItemState) {
  writeFileSync(stateFile(state.item), JSON.stringify(state, null, 2));
}

function newItemId(): string {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `item-${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function secretOk(given: string | undefined): boolean {
  const wanted = env.INTAKE_SECRET ?? "";
  if (!wanted || !given) return false;
  const left = Buffer.from(given), right = Buffer.from(wanted);
  return left.length === right.length && timingSafeEqual(left, right);
}

function reply(res: ServerResponse, code: number, body: unknown) {
  if (code >= 400) console.warn(`intake ${code}: ${JSON.stringify(body)}`);
  res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
}

// POST /intake, multipart: photos (1-8 images), size, condition, flaws. Header X-SecondLife-Secret.
async function handleIntake(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST" || req.url !== "/intake") return reply(res, 404, { error: "not found" });
  if (!env.INTAKE_SECRET) return reply(res, 503, { error: "INTAKE_SECRET is not set in agent/.env" });
  if (!secretOk(req.headers["x-secondlife-secret"] as string | undefined)) return reply(res, 401, { error: "bad secret" });
  if (Number(req.headers["content-length"] ?? 0) > MAX_PHOTOS * MAX_PHOTO_BYTES + 1_000_000) return reply(res, 413, { error: "upload too large" });

  let form: FormData;
  try {
    form = await new Request("http://intake.local/intake", {
      method: "POST",
      headers: { "content-type": String(req.headers["content-type"] ?? "") },
      body: Readable.toWeb(req) as ReadableStream,
      duplex: "half",
    } as RequestInit).formData();
  } catch {
    return reply(res, 400, { error: "expected multipart/form-data" });
  }
  const photos = [...form.values()].filter((value): value is File => value instanceof File);
  for (const line of String(form.get("photos_b64") ?? "").split(/\s*\n\s*/).filter(Boolean)) {
    const bytes = Buffer.from(line, "base64");
    const png = bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
    if (!png && !jpeg) return reply(res, 400, { error: "photos_b64 holds something that is not a JPEG or PNG" });
    photos.push(new File([bytes], `photo-${photos.length + 1}.${png ? "png" : "jpg"}`, { type: png ? "image/png" : "image/jpeg" }));
  }
  if (!photos.length || photos.length > MAX_PHOTOS) {
    const received = [...form.entries()].map(([key, value]) => `${key}=${value instanceof File ? `file(${value.type},${value.size}b)` : JSON.stringify(String(value).slice(0, 40))}`);
    return reply(res, 400, { error: `send 1 to ${MAX_PHOTOS} photos`, received });
  }
  for (const photo of photos) {
    if (!photo.type.startsWith("image/") || photo.size > MAX_PHOTO_BYTES) return reply(res, 400, { error: `not an image or over 10 MB: ${photo.name}` });
  }
  const field = (key: string) => String(form.get(key) ?? "").trim().slice(0, 200);
  const item = newItemId();
  mkdirSync(join(INTAKE, item), { recursive: true });
  const names: string[] = [];
  for (const [index, photo] of photos.entries()) {
    const name = `photo-${index + 1}.${photo.type === "image/png" ? "png" : "jpg"}`;
    writeFileSync(join(INTAKE, item, name), Buffer.from(await photo.arrayBuffer()));
    names.push(name);
  }
  save({
    item,
    status: "new",
    created: new Date().toISOString(),
    facts: { size: field("size"), condition: field("condition"), flaws: field("flaws") },
    photos: names,
    fileIds: [],
  });
  console.log(`${item}: received ${names.length} photos`);
  reply(res, 202, { item, message: `Got ${names.length} photos. eBay listing and Vinted draft on the way.` });
}

async function listEvents(session: string): Promise<Record<string, unknown>[]> {
  const events: Record<string, unknown>[] = [];
  const base = `/sessions/${session}/events`;
  let path: string | null = `${base}?limit=100`;
  const pages = new Set<string>();
  while (path && !pages.has(path)) {
    pages.add(path);
    const page = record(await api("GET", path));
    events.push(...array(page.data).map(record));
    const next = page.next_page ?? record(page.pagination).next;
    if (typeof next === "string" && next) {
      path = next.startsWith("http")
        ? new URL(next).pathname + new URL(next).search
        : next.startsWith("/")
          ? next
          : `${base}?limit=100&page=${encodeURIComponent(next)}`;
    } else if (page.has_more === true && typeof page.last_id === "string") {
      path = `${base}?limit=100&after_id=${encodeURIComponent(page.last_id)}`;
    } else {
      path = null;
    }
  }
  return events;
}

function pendingTools(events: Record<string, unknown>[]): Record<string, unknown>[] {
  const answered = new Set(events.filter((event) => event.type === "user.custom_tool_result").map((event) => String(event.custom_tool_use_id ?? "")));
  return events.filter((event) => event.type === "agent.custom_tool_use" && !answered.has(String(event.id ?? "")));
}

export async function dispatchTool(scope: ToolScope, name: unknown, input: unknown): Promise<unknown> {
  const tool = String(name ?? "");
  if (tool !== "ebay_research" && tool !== "ebay_seller") return { error: "not_found" };

  if (tool === "ebay_research") {
    if (scope.kind === "research" || scope.kind === "listing" || scope.kind === "vinted") {
      return runResearchTool(scope.item, input);
    }
    const detail = scope.kind === "inbox"
      ? "inbox sessions may only use ebay_seller"
      : "this session may not use custom tools";
    return { error: "policy", detail };
  }

  if (scope.kind === "listing") {
    const call = record(input);
    if (call.action === "publish_listing" && call.item_id === scope.item) return runSellerTool(input);
    return { error: "policy", detail: `listing sessions may only publish item ${scope.item}` };
  }
  if (scope.kind === "inbox") {
    if (record(input).action !== "publish_listing") return runSellerTool(input);
    return { error: "policy", detail: "inbox sessions may not publish listings" };
  }
  const detail = scope.kind === "none"
    ? "this session may not use custom tools"
    : `${scope.kind} sessions may only use ebay_research`;
  return { error: "policy", detail };
}

export async function serveTools(session: string, scope: ToolScope): Promise<number> {
  const pending = pendingTools(await listEvents(session));
  for (const event of pending) {
    const id = String(event.id ?? "");
    if (!id) continue;
    const result = await dispatchTool(scope, event.name, event.input);
    await api("POST", `/sessions/${session}/events`, {
      events: [{
        type: "user.custom_tool_result",
        custom_tool_use_id: id,
        content: [{ type: "text", text: JSON.stringify(result) }],
      }],
    });
  }
  return pending.length;
}

async function settled(session: string, scope: ToolScope): Promise<Settlement | null> {
  await serveTools(session, scope);
  const details = record(await api("GET", `/sessions/${session}`));
  const evaluations = array(details.outcome_evaluations).map(record);
  const verdict = String(evaluations.at(-1)?.result ?? "");
  if (details.status === "terminated") return { status: "terminated", verdict };
  if (details.status !== "idle" || !verdict || verdict === "pending") return null;
  if (pendingTools(await listEvents(session)).length) return null;
  return { status: "idle", verdict };
}

function accepted(result: Settlement, kind: string) {
  if (result.status === "terminated" || !["satisfied", "max_iterations_reached"].includes(result.verdict)) {
    throw new Error(`${kind} ended: ${result.status} ${result.verdict}`);
  }
}

function requestQuestions(session: string): string[] {
  const dir = join(RUNS, session, "outbox");
  if (!existsSync(dir)) return [];
  const questions: string[] = [];
  for (const name of readdirSync(dir).filter((file) => file.endsWith(".json")).sort()) {
    try {
      const request = record(JSON.parse(readFileSync(join(dir, name), "utf8")));
      if (request.action === "request_user_input" && request.question) questions.push(String(request.question).slice(0, 500));
    } catch { /* a malformed output is ignored, not executed */ }
  }
  return questions;
}

async function notifyRequests(session: string, item: string) {
  for (const question of requestQuestions(session)) await notify(`eBay needs you: ${item}`, question);
}

const text = (value: unknown, max = 5000) => String(value ?? "").slice(0, max);

// Fill Vinted's web "Sell an item" form and save it as a draft. Title, description, photos and price
// are required. The pickers (category, brand, size, condition, colours, parcel size) are best effort:
// their layout changes often, so misses are reported instead of failing the draft.
// Picker instructions follow what the live form showed on 2026-09-24: searchable category and brand
// lists, sizes labelled like "M / UK 12-14", and a "Proof of authenticity" dialog after some brands.
async function fillVintedDraft(h: Hands, state: ItemState): Promise<DraftResult> {
  const listing = state.vinted?.listing ?? {};
  await h.page.goto("https://www.vinted.co.uk/items/new");
  await humanPause();
  const reason = await blockedReason(h);
  if (reason) throw new Error(reason);

  await h.page.locator('input[type="file"]').setInputFiles(state.photos.map((name) => join(INTAKE, state.item, name)));
  await sleep(4000 + 1500 * state.photos.length);

  const fill = async (what: string, value: string) => {
    const { data } = await h.stagehand.observe(`find the ${what}`);
    if (!data.length) throw new Error(`no ${what} on the form`);
    await h.page.locator(data[0].selector).fill(value);
    await humanPause();
  };
  await fill("item title text input", text(listing.title, 100));
  await fill("item description textarea", text(listing.description));

  const skipped: string[] = [];
  const pick = async (label: string, value: unknown, instruction: string) => {
    if (!value) { skipped.push(label); return; }
    try { await h.stagehand.act(instruction); await humanPause(); } catch { skipped.push(label); }
  };
  const categoryPath = text(listing.category_path, 160);
  await pick("category", categoryPath, `Open the Category picker, type "${categoryPath.split(">").pop()!.trim()}" in its search box, and select the result whose path best matches "${categoryPath}".`);
  await pick("brand", listing.brand, `Open the Brand picker, search "${text(listing.brand, 60)}", and select that exact brand.`);
  await h.stagehand.act('If a dialog titled "Proof of authenticity" is open, click its Close button. Otherwise do nothing.').catch(() => undefined);
  await pick("size", listing.size, `Open the Size picker and select the option for size "${text(listing.size, 30)}". Options read like "M / UK 12-14", so match on the size before the slash.`);
  await pick("condition", listing.condition, `Open the Condition picker and select "${text(listing.condition, 40)}".`);
  const colours = Array.isArray(listing.colours) ? listing.colours.slice(0, 2).map((colour) => text(colour, 30)) : [];
  await pick("colours", colours.length, `Open the Colours picker, tick ${colours.map((colour) => `"${colour}"`).join(" and ")}, then close the picker.`);
  await pick("parcel size", listing.parcel_size, `In the Shipping section, select the "${text(listing.parcel_size, 20)}" parcel size.`);
  await fill("price input", String(listing.price_gbp ?? ""));

  let hint: PriceHint | null = null;
  try {
    const { data } = await h.stagehand.extract(
      "Read Vinted's price recommendation for this listing: the Bargain, Optimal and Premium amounts in GBP (null for any not shown).",
      PriceHint,
    );
    if (data.optimal !== null || data.bargain !== null) hint = data;
  } catch { /* no suggestion shown */ }

  await h.stagehand.act('Click the "Save draft" button. Do not click Upload or Publish.');
  await humanPause();
  if (/items\/new/.test(await h.page.url())) throw new Error("the form did not save; check it in the worker's Chrome window");
  return { skipped, hint };
}

// Keep Vinted's suggestion next to the dossier, so later sessions can use it for negotiation and repricing.
async function saveHint(item: string, hint: PriceHint, listed: unknown) {
  await api("POST", `/memory_stores/${env.MEMSTORE_ID}/memories`, {
    path: `/items/${item}/vinted-price-suggestion.json`,
    content: JSON.stringify({ source: "Vinted sell form price recommendation", recorded_at: new Date().toISOString(), listed_gbp: listed, ...hint }, null, 2),
  }, MEM_BETA).catch(() => undefined);
}

let hands: Hands | null = null;

async function stepVinted(item: string) {
  const state = load(item);
  if (!state.vinted) {
    if (!state.listingSession) return;
    state.vinted = { status: !env.VINTED_ID || env.VINTED_DISABLED === "1" ? "skipped" : "listing" };
    save(state);
    if (state.vinted.status === "skipped") return;
  }

  const vinted = state.vinted;
  if (vinted.status === "listing") {
    if (!vinted.session) {
      if (!env.VINTED_VERSION) throw new Error("VINTED_VERSION is missing");
      vinted.session = await startSession({
        kind: "vinted",
        item: state.item,
        agentId: env.VINTED_ID,
        agentVersion: env.VINTED_VERSION,
        task: fillTemplate("first_prompt-vinted.txt", { ITEM: state.item }),
        rubricFile: "outcome-vinted.md",
        maxIterations: 1,
      });
      save(state);
      console.log(`${state.item}: Vinted listing ${vinted.session}`);
      return;
    }
    const result = await settled(vinted.session, { kind: "vinted", item });
    if (!result) return;
    await fetchOutputs(vinted.session);
    const file = join(RUNS, vinted.session, "vinted.json");
    const listing = existsSync(file) ? record(JSON.parse(readFileSync(file, "utf8"))) : {};
    if (!listing.title || !listing.description) throw new Error(`no Vinted title or description in vinted.json (${result.verdict})`);
    vinted.listing = listing;
    vinted.status = "drafting";
    save(state);
    return;
  }

  if (vinted.status === "drafting") {
    hands ??= await openBrowser();
    const { skipped, hint } = await fillVintedDraft(hands, state);
    vinted.skippedFields = skipped;
    vinted.priceHint = hint ?? undefined;
    vinted.status = "drafted";
    save(state);
    if (hint) await saveHint(state.item, hint, vinted.listing?.price_gbp);

    const price = Number(vinted.listing?.price_gbp);
    const outside = hint && ((hint.premium !== null && price > hint.premium) || (hint.bargain !== null && price < hint.bargain));
    const priceNote = hint ? `Vinted suggests £${hint.bargain ?? "?"}-£${hint.premium ?? "?"} (optimal £${hint.optimal ?? "?"})${outside ? ", so review the price" : ""}.` : "";
    const check = skipped.length ? `Check: ${skipped.join(", ")}.` : "";
    console.log(`${state.item}: Vinted draft saved at £${price}. ${priceNote} ${check}`.trim());
    await notify(`Vinted draft ready: ${text(vinted.listing?.title, 80)} £${price}`, `${priceNote} ${check} Open Vinted ▸ Drafts.`.trim());
  }
}

async function clearCloudPhotos(state: ItemState) {
  for (const id of state.fileIds) await deleteFile(id);
  state.fileIds = [];
}

function clearLocalPhotosIfDone(state: ItemState) {
  const ebayDone = ["live", "needs_you", "failed"].includes(state.status);
  const vintedDone = state.vinted
    ? ["drafted", "failed", "skipped"].includes(state.vinted.status)
    : !env.VINTED_ID;
  if (!ebayDone || !vintedDone) return;
  for (const name of state.photos) rmSync(join(INTAKE, state.item, name), { force: true });
}

async function step(item: string) {
  const state = load(item);
  const id = state.item;
  switch (state.status) {
    case "new": {
      for (const name of state.photos.slice(state.fileIds.length)) {
        state.fileIds.push(await uploadFile(join(INTAKE, id, name)));
        save(state);
      }
      state.researchSession = await startSession({
        kind: "research",
        item: id,
        agentId: env.RESEARCHER_ID,
        agentVersion: env.RESEARCHER_VERSION,
        task: fillTemplate("first_prompt-intake.txt", { ITEM: id, SIZE: state.facts.size, CONDITION: state.facts.condition, FLAWS: state.facts.flaws }),
        rubricFile: "outcome-research.md",
        maxIterations: INTAKE_ITERATIONS,
        files: state.fileIds.map((fileId, index) => ({ id: fileId, name: state.photos[index] })),
      });
      state.status = "researching";
      save(state);
      console.log(`${id}: research ${state.researchSession}`);
      return;
    }
    case "researching": {
      if (!state.researchSession) throw new Error("research session is missing");
      const result = await settled(state.researchSession, { kind: "research", item: id });
      if (!result) return;
      accepted(result, "research");
      state.listingSession = await startSession({
        kind: "sell",
        item: id,
        agentId: env.EBAY_POSTER_ID || env.SELLER_ID,
        agentVersion: env.EBAY_POSTER_VERSION || env.SELLER_VERSION,
        task: fillTemplate("first_prompt-listing.txt", { ITEM: id }),
        rubricFile: "outcome-listing.md",
        maxIterations: INTAKE_ITERATIONS,
      });
      state.status = "listing";
      save(state);
      console.log(`${id}: listing ${state.listingSession}`);
      return;
    }
    case "listing": {
      if (!state.listingSession) throw new Error("listing session is missing");
      const result = await settled(state.listingSession, { kind: "listing", item: id });
      if (!result) return;
      await fetchOutputs(state.listingSession);
      const current = load(id);
      await clearCloudPhotos(current);
      if (current.listingId && current.url && current.listedGbp !== undefined) {
        current.status = "live";
        console.log(`${id}: live ${current.url}`);
        await notify("Live on eBay", `${current.title ?? id} £${current.listedGbp} ${current.url}`);
      } else {
        current.status = "needs_you";
        await notifyRequests(state.listingSession, id);
      }
      save(current);
      return;
    }
  }
}

function persistDelivered() {
  mkdirSync(RUNS, { recursive: true });
  let seen: string[] = [];
  if (existsSync(SEEN_FILE)) {
    try { seen = z.array(z.string()).parse(JSON.parse(readFileSync(SEEN_FILE, "utf8"))); } catch { /* replace invalid local cache */ }
  }
  writeFileSync(SEEN_FILE, JSON.stringify([...new Set([...seen, ...delivered])].sort(), null, 2));
  delivered.clear();
}

async function finishInbox(session: string) {
  persistDelivered();
  await fetchOutputs(session);
  await notifyRequests(session, "inbox");
}


async function startInboxSession(): Promise<string | null> {
  const preview = record(await runSellerTool({ action: "get_inbox" }));
  if (preview.error) throw new Error(`${preview.error}: ${preview.detail}`);
  if (!array(preview.questions).length && !array(preview.offers).length) return null;
  const session = await startSession({
    kind: "inbox",
    item: "ebay",
    agentId: env.EBAY_BUYER_ID || env.SELLER_ID,
    agentVersion: env.EBAY_BUYER_VERSION || env.SELLER_VERSION,
    task: fillTemplate("first_prompt-inbox.txt", {}),
    rubricFile: "outcome-reply.md",
    maxIterations: 1,
  });
  console.log(`inbox: ${session}`);
  return session;
}

let inboxSession: string | null = null;
let nextInboxAt = 0;

async function pollInbox() {
  if (inboxSession) {
    const result = await settled(inboxSession, { kind: "inbox" });
    if (!result) return;
    await finishInbox(inboxSession);
    inboxSession = null;
    nextInboxAt = Date.now() + INBOX_MS;
    return;
  }
  if (Date.now() < nextInboxAt || !liveItems().length) return;
  inboxSession = await startInboxSession();
  if (!inboxSession) nextInboxAt = Date.now() + INBOX_MS;
}

function liveItems(): ItemState[] {
  if (!existsSync(INTAKE)) return [];
  const items: ItemState[] = [];
  for (const item of readdirSync(INTAKE).sort()) {
    if (!existsSync(stateFile(item))) continue;
    try {
      const state = load(item);
      if (state.status === "live") items.push(state);
    } catch { /* another item remains usable */ }
  }
  return items;
}

async function loop() {
  for (;;) {
    const items = existsSync(INTAKE) ? readdirSync(INTAKE).filter((item) => existsSync(stateFile(item))).sort() : [];
    for (const item of items) {
      let state = load(item);
      if (!["live", "needs_you", "failed"].includes(state.status) && state.status !== process.env.HOLD_AT) {
        try {
          await step(item);
          const current = load(item);
          if (current.attempts) {
            current.attempts = 0;
            current.error = undefined;
            save(current);
          }
        } catch (error) {
          const current = load(item);
          current.error = String(error instanceof Error ? error.message : error).slice(0, 500);
          current.attempts = (current.attempts ?? 0) + 1;
          if (current.attempts >= 3) {
            current.status = "failed";
            console.error(`${item}: ${current.error}`);
            await notify("SecondLife eBay item failed", `${item}: ${current.error}`);
          } else {
            console.warn(`${item}: try ${current.attempts}/3 failed: ${current.error}`);
          }
          save(current);
        }
      }

      state = load(item);
      const vintedActive = state.vinted
        ? ["listing", "drafting"].includes(state.vinted.status)
        : Boolean(state.listingSession);
      if (vintedActive && !(state.vinted?.status === "drafting" && process.env.HOLD_AT === "drafting")) {
        try {
          await stepVinted(item);
          const current = load(item);
          if (current.vinted?.attempts) {
            current.vinted.attempts = 0;
            current.vinted.error = undefined;
            save(current);
          }
        } catch (error) {
          const current = load(item);
          if (!current.vinted) current.vinted = { status: "listing" };
          const vinted = current.vinted;
          vinted.error = String(error instanceof Error ? error.message : error).slice(0, 500);
          vinted.attempts = (vinted.attempts ?? 0) + 1;
          if (vinted.status === "drafting") hands = null;
          if (vinted.attempts >= 3) {
            vinted.status = "failed";
            console.error(`${item}: Vinted ${vinted.error}`);
            await notify("SecondLife Vinted draft failed", `${item}: ${vinted.error}`);
          } else {
            console.warn(`${item}: Vinted try ${vinted.attempts}/3 failed: ${vinted.error}`);
          }
          save(current);
        }
      }
      clearLocalPhotosIfDone(load(item));
    }
    try { await pollInbox(); } catch (error) {
      console.error(`inbox: ${error instanceof Error ? error.message : error}`);
      nextInboxAt = Date.now() + INBOX_MS;
    }
    await sleep(POLL_MS);
  }
}

export async function suggestVintedReply({ buyer, listing, message }: {
  buyer: string;
  listing: string;
  message: string;
}): Promise<string> {
  if (!env.VINTED_REPLY_ID || !env.VINTED_REPLY_VERSION) {
    throw new Error("VINTED_REPLY_ID and VINTED_REPLY_VERSION are missing");
  }
  const session = await startSession({
    kind: "vinted-reply",
    item: listing,
    agentId: env.VINTED_REPLY_ID,
    agentVersion: env.VINTED_REPLY_VERSION,
    task: fillTemplate("first_prompt-vinted-reply.txt", { BUYER: buyer, LISTING: listing, MESSAGE: message }),
    rubricFile: "outcome-vinted-reply.md",
    maxIterations: 1,
  });
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    if (Date.now() >= deadline) throw new Error(`Vinted reply session ${session} did not settle within 10 minutes`);
    const result = await settled(session, { kind: "none" });
    if (result) {
      accepted(result, "Vinted reply");
      break;
    }
    await sleep(Math.min(5000, deadline - Date.now()));
  }
  await fetchOutputs(session);
  const file = join(RUNS, session, "suggestion.json");
  if (!existsSync(file)) throw new Error(`Vinted reply session ${session} produced no suggestion.json`);
  const suggestion = record(JSON.parse(readFileSync(file, "utf8")));
  const suggestedReply = text(suggestion.suggested_reply).trim();
  if (!suggestedReply) throw new Error(`Vinted reply session ${session} produced no suggested_reply`);
  const shortMessage = text(message.trim().replace(/\s+/g, " "), 200);
  await notify(`Vinted reply for ${text(buyer, 80)}`, `${shortMessage}\n\nSuggested: ${suggestedReply}`);
  return suggestedReply;
}

export async function runInboxOnce() {
  const session = await startInboxSession();
  if (!session) {
    console.log("No new eBay questions or offers.");
    return;
  }
  for (;;) {
    const result = await settled(session, { kind: "inbox" });
    if (result) break;
    await sleep(5000);
  }
  await finishInbox(session);
  console.log(`Inbox session complete: ${session}`);
}

export async function watch() {
  if (!env.INTAKE_SECRET) console.warn("INTAKE_SECRET missing in agent/.env: the intake will refuse every upload.");
  mkdirSync(INTAKE, { recursive: true });
  createServer((req, res) => { handleIntake(req, res).catch((error) => reply(res, 500, { error: String(error instanceof Error ? error.message : error) })); })
    .listen(PORT, "0.0.0.0", () => console.log(`intake: POST http://<this-mac>:${PORT}/intake`));
  await loop();
}
