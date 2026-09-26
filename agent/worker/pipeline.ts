// Photo intake → research → listing → Vinted draft, for the iPhone "Sell on Vinted" Shortcut.
// One process (`worker.ts watch`): an HTTP intake the phone posts to, and a loop that moves
// each item through its states. Item state lives in runs/intake/<item>/state.json.
//
//   new ─▶ researching ─▶ listing ─▶ drafting ─▶ drafted
//     (any step can end in failed, with the reason in state.error)
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod/v4";
import { MEM_BETA, RUNS, api, deleteFile, env, fetchOutputs, fillTemplate, notify, sleep, startSession, uploadFile } from "./lib.ts";
import { blockedReason, humanPause, openBrowser, type Hands } from "./browser.ts";

const INTAKE = join(RUNS, "intake");
const PORT = Number(process.env.INTAKE_PORT ?? 4646);
const MAX_PHOTOS = 8;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const POLL_MS = 15_000;
// One graded pass per agent: a failed check is reported, not re-run. A second pass cost +35% for no better listing.
const INTAKE_ITERATIONS = 1;

type Status = "new" | "researching" | "listing" | "drafting" | "drafted" | "failed";
type ItemState = {
  item: string; status: Status; created: string;
  facts: { size: string; condition: string; flaws: string };
  photos: string[]; fileIds: string[];
  researchSession?: string; listingSession?: string;
  listing?: Record<string, unknown>; skippedFields?: string[]; priceHint?: PriceHint; error?: string; attempts?: number;
};

const stateFile = (item: string) => join(INTAKE, item, "state.json");
const load = (item: string): ItemState => JSON.parse(readFileSync(stateFile(item), "utf8"));
const save = (s: ItemState) => writeFileSync(stateFile(s.item), JSON.stringify(s, null, 2));

function newItemId(): string {
  const d = new Date(), p = (n: number) => String(n).padStart(2, "0");
  return `item-${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function secretOk(given: string | undefined): boolean {
  const want = env.INTAKE_SECRET ?? "";
  if (!want || !given) return false;
  const a = Buffer.from(given), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

const reply = (res: ServerResponse, code: number, body: unknown) => {
  if (code >= 400) console.warn(`📮 intake ${code}: ${JSON.stringify(body)}`);
  res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
};

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
  // Photos come as file parts (curl, other clients) or as base64 text, one per line, in photos_b64:
  // the iPhone Shortcut uses the text form because Shortcuts drops file fields from imported shortcuts.
  const photos = [...form.values()].filter((v): v is File => v instanceof File);
  for (const line of String(form.get("photos_b64") ?? "").split(/\s*\n\s*/).filter(Boolean)) {
    const bytes = Buffer.from(line, "base64");
    const png = bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
    if (!png && !jpeg) return reply(res, 400, { error: "photos_b64 holds something that is not a JPEG or PNG" });
    photos.push(new File([bytes], `photo-${photos.length + 1}.${png ? "png" : "jpg"}`, { type: png ? "image/png" : "image/jpeg" }));
  }
  if (!photos.length || photos.length > MAX_PHOTOS) {
    const got = [...form.entries()].map(([k, v]) => `${k}=${v instanceof File ? `file(${v.type},${v.size}b)` : JSON.stringify(String(v).slice(0, 40))}`);
    return reply(res, 400, { error: `send 1 to ${MAX_PHOTOS} photos`, received: got });
  }
  for (const p of photos) {
    if (!p.type.startsWith("image/") || p.size > MAX_PHOTO_BYTES) return reply(res, 400, { error: `not an image or over 10 MB: ${p.name}` });
  }
  const field = (k: string) => String(form.get(k) ?? "").trim().slice(0, 200);

  const item = newItemId();
  mkdirSync(join(INTAKE, item), { recursive: true });
  const names: string[] = [];
  for (const [i, p] of photos.entries()) {
    const ext = p.type === "image/png" ? "png" : "jpg";
    const name = `photo-${i + 1}.${ext}`;
    writeFileSync(join(INTAKE, item, name), Buffer.from(await p.arrayBuffer()));
    names.push(name);
  }
  save({
    item, status: "new", created: new Date().toISOString(),
    facts: { size: field("size"), condition: field("condition"), flaws: field("flaws") },
    photos: names, fileIds: [],
  });
  console.log(`📥 ${item}: ${names.length} photos`);
  reply(res, 202, { item, message: `Got ${names.length} photos. The Vinted draft for ${item} will appear in your Drafts.` });
}

// Returns the session once it has settled: idle with a verdict, or terminated.
async function settled(session: string): Promise<{ status: string; verdict: string } | null> {
  const s = await api("GET", `/sessions/${session}`);
  const verdict = (s.outcome_evaluations ?? []).at(-1)?.result ?? "";
  if (s.status === "terminated" || (s.status === "idle" && verdict && verdict !== "pending")) return { status: s.status, verdict };
  return null;
}

const text = (v: unknown, max = 5000) => String(v ?? "").slice(0, max);

type PriceHint = { bargain: number | null; optimal: number | null; premium: number | null };
type DraftResult = { skipped: string[]; hint: PriceHint | null };

// Fill Vinted's web "Sell an item" form and save it as a draft. Title, description, photos and price
// are required. The pickers (category, brand, size, condition, colours, parcel size) are best effort:
// their layout changes often, so misses are reported instead of failing the draft.
// Picker instructions follow what the live form showed on 2026-09-24: searchable category and brand
// lists, sizes labelled like "M / UK 12-14", and a "Proof of authenticity" dialog after some brands.
async function fillVintedDraft(h: Hands, s: ItemState): Promise<DraftResult> {
  const v = s.listing ?? {};
  await h.page.goto("https://www.vinted.co.uk/items/new");
  await humanPause();
  const why = await blockedReason(h);
  if (why) throw new Error(why);

  await h.page.locator('input[type="file"]').setInputFiles(s.photos.map((n) => join(INTAKE, s.item, n)));
  await sleep(4000 + 1500 * s.photos.length); // let the uploads finish before touching other fields

  const fill = async (what: string, value: string) => {
    const { data } = await h.stagehand.observe(`find the ${what}`);
    if (!data.length) throw new Error(`no ${what} on the form`);
    await h.page.locator(data[0].selector).fill(value);
    await humanPause();
  };
  await fill("item title text input", text(v.title, 100));
  await fill("item description textarea", text(v.description));

  const skipped: string[] = [];
  const pick = async (label: string, value: unknown, instruction: string) => {
    if (!value) { skipped.push(label); return; }
    try { await h.stagehand.act(instruction); await humanPause(); } catch { skipped.push(label); }
  };
  const path = text(v.category_path, 160);
  await pick("category", path, `Open the Category picker, type "${path.split(">").pop()!.trim()}" in its search box, and select the result whose path best matches "${path}".`);
  await pick("brand", v.brand, `Open the Brand picker, search "${text(v.brand, 60)}", and select that exact brand.`);
  // Some brands open a "Proof of authenticity" dialog that covers the form.
  await h.stagehand.act('If a dialog titled "Proof of authenticity" is open, click its Close button. Otherwise do nothing.').catch(() => undefined);
  await pick("size", v.size, `Open the Size picker and select the option for size "${text(v.size, 30)}". Options read like "M / UK 12-14", so match on the size before the slash.`);
  await pick("condition", v.condition, `Open the Condition picker and select "${text(v.condition, 40)}".`);
  const colours = Array.isArray(v.colours) ? v.colours.slice(0, 2).map((c) => text(c, 30)) : [];
  await pick("colours", colours.length, `Open the Colours picker, tick ${colours.map((c) => `"${c}"`).join(" and ")}, then close the picker.`);
  await pick("parcel size", v.parcel_size, `In the Shipping section, select the "${text(v.parcel_size, 20)}" parcel size.`);
  await fill("price input", String(v.price_gbp ?? ""));

  // Vinted shows its own price suggestion once category, brand and condition are set.
  let hint: PriceHint | null = null;
  try {
    const { data } = await h.stagehand.extract(
      "Read Vinted's price recommendation for this listing: the Bargain, Optimal and Premium amounts in GBP (null for any not shown).",
      z.object({ bargain: z.number().nullable(), optimal: z.number().nullable(), premium: z.number().nullable() }),
    );
    if (data.optimal !== null || data.bargain !== null) hint = data;
  } catch { /* no suggestion shown */ }

  await h.stagehand.act('Click the "Save draft" button. Do not click Upload or Publish.');
  await humanPause();
  if (/items\/new/.test(await h.page.url())) throw new Error("the form did not save; check it in the worker's Chrome window");
  return { skipped, hint };
}

// Keep Vinted's suggestion next to the dossier, so the seller agent sees it in later sessions
// (negotiation, repricing). Memory paths are unique, so a second write for the same item is skipped.
async function saveHint(item: string, hint: PriceHint, listed: unknown) {
  await api("POST", `/memory_stores/${env.MEMSTORE_ID}/memories`, {
    path: `/items/${item}/vinted-price-suggestion.json`,
    content: JSON.stringify({ source: "Vinted sell form price recommendation", recorded_at: new Date().toISOString(), listed_gbp: listed, ...hint }, null, 2),
  }, MEM_BETA).catch(() => undefined);
}

let hands: Hands | null = null;

async function step(item: string) {
  const s = load(item);
  const id = s.item;
  switch (s.status) {
    case "new": {
      for (const n of s.photos.slice(s.fileIds.length)) { s.fileIds.push(await uploadFile(join(INTAKE, id, n))); save(s); }
      s.researchSession = await startSession({
        kind: "research", item: id, agentId: env.RESEARCHER_ID, agentVersion: env.RESEARCHER_VERSION,
        task: fillTemplate("first_prompt-intake.txt", { ITEM: id, SIZE: s.facts.size, CONDITION: s.facts.condition, FLAWS: s.facts.flaws }),
        rubricFile: "outcome-research.md", maxIterations: INTAKE_ITERATIONS,
        files: s.fileIds.map((fid, i) => ({ id: fid, name: s.photos[i] })),
      });
      s.status = "researching"; save(s);
      console.log(`🔎 ${id}: research ${s.researchSession}`);
      return;
    }
    case "researching": {
      const r = await settled(s.researchSession!);
      if (!r) return;
      if (r.status === "terminated" || !["satisfied", "max_iterations_reached"].includes(r.verdict)) throw new Error(`research ended: ${r.status} ${r.verdict}`);
      s.listingSession = await startSession({
        kind: "sell", item: id, agentId: env.SELLER_ID, agentVersion: env.SELLER_VERSION,
        task: fillTemplate("first_prompt-listing.txt", { ITEM: id }), rubricFile: "outcome-listing.md", maxIterations: INTAKE_ITERATIONS,
      });
      s.status = "listing"; save(s);
      console.log(`✍️  ${id}: listing ${s.listingSession} (research ${r.verdict})`);
      return;
    }
    case "listing": {
      const r = await settled(s.listingSession!);
      if (!r) return;
      await fetchOutputs(s.listingSession!);
      const file = join(RUNS, s.listingSession!, "listings.json");
      const vinted = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).vinted : null;
      if (!vinted?.title || !vinted?.description) throw new Error(`no Vinted title or description in listings.json (${r.verdict})`);
      s.listing = vinted; s.status = "drafting"; save(s);
      return;
    }
    case "drafting": {
      hands ??= await openBrowser();
      const { skipped, hint } = await fillVintedDraft(hands, s);
      s.skippedFields = skipped; s.priceHint = hint ?? undefined;
      s.status = "drafted"; save(s);
      if (hint) await saveHint(id, hint, s.listing?.price_gbp);
      for (const fid of s.fileIds) await deleteFile(fid);
      for (const n of s.photos) rmSync(join(INTAKE, id, n), { force: true });
      const listed = Number(s.listing?.price_gbp);
      const outside = hint && ((hint.premium !== null && listed > hint.premium) || (hint.bargain !== null && listed < hint.bargain));
      const priceNote = hint ? ` Vinted suggests £${hint.bargain ?? "?"}-£${hint.premium ?? "?"} (optimal £${hint.optimal ?? "?"})${outside ? ", so review the price" : ""}.` : "";
      const check = skipped.length ? ` Check: ${skipped.join(", ")}.` : "";
      console.log(`✅ ${id}: Vinted draft saved at £${listed}.${priceNote}${check}`);
      await notify("Vinted draft ready", `${text(s.listing?.title, 80)} (£${listed}).${priceNote}${check} Open Vinted ▸ Drafts.`);
      return;
    }
  }
}

async function loop() {
  for (;;) {
    const items = existsSync(INTAKE) ? readdirSync(INTAKE).filter((d) => existsSync(stateFile(d))).sort() : [];
    for (const item of items) {
      const s = load(item);
      if (s.status === "drafted" || s.status === "failed" || s.status === process.env.HOLD_AT) continue; // HOLD_AT=drafting stages items without touching Vinted
      try {
        await step(item); // one item at a time keeps the browser at human pace
        const ok = load(item);
        if (ok.attempts) { ok.attempts = 0; save(ok); }
      } catch (e: any) {
        const cur = load(item);
        cur.error = String(e?.message ?? e).slice(0, 500);
        cur.attempts = (cur.attempts ?? 0) + 1;
        if (cur.status === "drafting") hands = null; // a broken browser is reopened on the next try
        // ponytail: 3 tries then give up. Set status back in state.json to retry by hand.
        if (cur.attempts >= 3) {
          cur.status = "failed";
          console.error(`❌ ${item}: ${cur.error}`);
          await notify("SecondLife item failed", `${item}: ${cur.error}`);
        } else {
          console.warn(`↻ ${item}: try ${cur.attempts}/3 failed: ${cur.error}`);
        }
        save(cur);
      }
    }
    await sleep(POLL_MS);
  }
}

export async function watch() {
  if (!env.INTAKE_SECRET) console.warn("⚠️  INTAKE_SECRET missing in agent/.env: the intake will refuse every upload.");
  mkdirSync(INTAKE, { recursive: true });
  // 0.0.0.0 so the phone reaches it over Tailscale or home Wi-Fi. Every upload needs the shared secret.
  createServer((req, res) => { handleIntake(req, res).catch((e) => reply(res, 500, { error: String(e?.message ?? e) })); })
    .listen(PORT, "0.0.0.0", () => console.log(`📮 intake: POST http://<this-mac>:${PORT}/intake`));
  await loop();
}
