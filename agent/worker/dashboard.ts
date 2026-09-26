// Read-only local dashboard. npx tsx dashboard.ts -> http://127.0.0.1:4545
import { createServer, type ServerResponse } from "node:http";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const RUNS = join(dirname(fileURLToPath(import.meta.url)), "..", "runs");
const INTAKE = join(RUNS, "intake");
const PORT = Number(process.env.PORT ?? 4545);

type JsonObject = Record<string, unknown>;
type DatedHtml = { at: number; html: string };

function record(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readObject(path: string): JsonObject | null {
  try { return record(JSON.parse(readFileSync(path, "utf8"))); } catch { return null; }
}

const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
const money = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? `£${Number.isInteger(value) ? value : value.toFixed(2)}` : "—";
const tag = (value: unknown) => {
  const text = String(value || "not started");
  const tone = ["live", "drafted"].includes(text) ? "ok" : ["researching", "listing", "drafting", "new"].includes(text) ? "run" : ["failed", "needs_you"].includes(text) ? "warn" : "";
  return `<span class="tag ${tone}">${esc(text)}</span>`;
};

function dossierSummary(state: JsonObject): string {
  const session = typeof state.researchSession === "string" ? state.researchSession : "";
  if (!session) return "";
  const dossier = readObject(join(RUNS, session, "dossier.json"));
  if (!dossier) return "";
  const identity = record(dossier.identity);
  const pricing = record(dossier.pricing);
  const ebay = record(pricing.ebay);
  const vinted = record(pricing.vinted);
  const comps = array(ebay.comps_used).map(record);
  const name = [identity.brand, identity.model].filter((value) => typeof value === "string" && value).join(" ");
  const compList = comps.length
    ? `<ol>${comps.map((comp) => `<li>${esc(comp.title)} <strong>${esc(money(comp.price_gbp))}</strong></li>`).join("")}</ol>`
    : `<span class="muted">No comparable listings recorded.</span>`;
  return `<div class="dossier"><strong>${esc(name || "Identity pending")}</strong>
    <div>eBay: low ${esc(money(ebay.low_gbp))} · list ${esc(money(ebay.price_gbp))} · high ${esc(money(ebay.high_gbp))} · fast ${esc(money(ebay.fast_sale_gbp))}</div>
    <div>Vinted: ${esc(money(vinted.price_gbp))}</div>
    <details><summary>${comps.length} comps used</summary>${compList}</details></div>`;
}

function itemCards(): string {
  if (!existsSync(INTAKE)) return `<p class="muted">No items yet.</p>`;
  const cards = readdirSync(INTAKE, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const state = readObject(join(INTAKE, entry.name, "state.json"));
      if (!state) return { created: "", html: `<article class="item"><h3>${esc(entry.name)}</h3><p class="error">Unreadable state.json</p></article>` };
      const item = typeof state.item === "string" ? state.item : entry.name;
      const created = typeof state.created === "string" ? state.created : "";
      const photos = array(state.photos)
        .filter((value): value is string => typeof value === "string" && existsSync(join(INTAKE, entry.name, value)));
      const thumbnails = photos.length
        ? `<div class="photos">${photos.map((photo) => `<img loading="lazy" src="/photos/${encodeURIComponent(entry.name)}/${encodeURIComponent(photo)}" alt="${esc(item)} photo">`).join("")}</div>`
        : `<span class="muted">Photos cleaned up.</span>`;
      const vinted = record(state.vinted);
      const listing = record(vinted.listing);
      const hint = record(vinted.priceHint);
      const suggestion = Object.keys(hint).length
        ? `${money(hint.bargain)}–${money(hint.premium)} · optimal ${money(hint.optimal)}`
        : "—";
      const skipped = array(vinted.skippedFields).filter((value): value is string => typeof value === "string");
      const url = typeof state.url === "string" && state.url.startsWith("https://") ? state.url : "";
      const errors = [
        typeof state.error === "string" ? `eBay: ${state.error}` : "",
        typeof vinted.error === "string" ? `Vinted: ${vinted.error}` : "",
      ].filter(Boolean);
      return {
        created,
        html: `<article class="item">
          <header><div><h3>${esc(item)}</h3><span class="muted mono">${esc(created)}</span></div>${thumbnails}</header>
          <div class="channels">
            <section><h4>eBay</h4><div>${tag(state.status)} <strong>${esc(money(state.listedGbp))}</strong>${url ? ` · <a href="${esc(url)}" target="_blank" rel="noreferrer">listing</a>` : ""}</div></section>
            <section><h4>Vinted</h4><div>${tag(vinted.status)} <strong>${esc(money(listing.price_gbp))}</strong></div><div class="small">Suggestion: ${esc(suggestion)}</div><div class="small">Skipped: ${esc(skipped.join(", ") || "none")}</div></section>
          </div>
          ${dossierSummary(state)}
          ${errors.length ? `<div class="error"><strong>Last error:</strong> ${esc(errors.join(" · "))}</div>` : ""}
        </article>`,
      };
    })
    .sort((left, right) => right.created.localeCompare(left.created));
  return cards.map((card) => card.html).join("") || `<p class="muted">No items yet.</p>`;
}

function buyerInbox(): string {
  if (!existsSync(RUNS)) return `<p class="muted">No inbox runs yet.</p>`;
  const reports: DatedHtml[] = [];
  const escalations: DatedHtml[] = [];
  for (const entry of readdirSync(RUNS, { withFileTypes: true }).filter((candidate) => candidate.isDirectory())) {
    const runDir = join(RUNS, entry.name);
    const report = join(runDir, "inbox-report.md");
    if (existsSync(report)) {
      reports.push({ at: statSync(report).mtimeMs, html: `<article class="note"><div class="meta">${esc(entry.name)}</div><pre>${esc(readFileSync(report, "utf8"))}</pre></article>` });
    }
    const outbox = join(runDir, "outbox");
    if (!existsSync(outbox)) continue;
    for (const file of readdirSync(outbox).filter((name) => name.includes("request_user_input") && name.endsWith(".json"))) {
      const path = join(outbox, file);
      const request = readObject(path);
      if (!request) continue;
      const options = array(request.options).map((option) => String(option));
      escalations.push({
        at: statSync(path).mtimeMs,
        html: `<article class="note ask"><div class="meta">${esc(entry.name)} · ${esc(request.item_id)}</div><strong>${esc(request.question)}</strong>${options.length ? `<ul>${options.map((option) => `<li>${esc(option)}</li>`).join("")}</ul>` : ""}${request.reason ? `<div class="small muted">${esc(request.reason)}</div>` : ""}</article>`,
      });
    }
  }
  reports.sort((left, right) => right.at - left.at);
  escalations.sort((left, right) => right.at - left.at);
  return `<div class="inbox-grid"><section><h3>Recent reports</h3>${reports.slice(0, 5).map((report) => report.html).join("") || `<p class="muted">No inbox reports.</p>`}</section><section><h3>Escalations</h3>${escalations.map((request) => request.html).join("") || `<p class="muted">Nothing is waiting on you.</p>`}</section></div>`;
}

function render(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="5"><title>SecondLife sales</title><style>
:root{--bg:#f5f3ef;--card:#fff;--ink:#20201e;--muted:#6d6962;--line:#ddd7ce;--ok:#24745d;--run:#9a6819;--warn:#b24d34;--accent:#7048a8}
@media(prefers-color-scheme:dark){:root{--bg:#171715;--card:#242320;--ink:#eeeae3;--muted:#aaa49a;--line:#3e3a34;--ok:#63b99e;--run:#e0ad58;--warn:#ed876f;--accent:#bd98ee}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:1120px;margin:auto;padding:24px 16px 48px}h1{font-size:22px;margin:0}h2{font-size:14px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:30px 0 12px}h3,h4{margin:0 0 6px}h4{font-size:12px;text-transform:uppercase;color:var(--muted)}a{color:var(--accent)}.muted{color:var(--muted)}.small,.meta{font-size:12px}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.item,.note{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin:0 0 12px}.item header{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.photos{display:flex;gap:6px;overflow-x:auto;max-width:55%}.photos img{width:72px;height:72px;object-fit:cover;border-radius:8px;border:1px solid var(--line)}.channels,.inbox-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.channels{margin-top:12px}.channels section,.dossier{border-top:1px solid var(--line);padding-top:10px}.dossier{margin-top:10px}.dossier ol{margin:6px 0 0;padding-left:22px}.tag{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:1px 8px;font-size:12px}.tag.ok{color:var(--ok);border-color:var(--ok)}.tag.run{color:var(--run);border-color:var(--run)}.tag.warn,.error{color:var(--warn)}.error{margin-top:10px;overflow-wrap:anywhere}.note.ask{border-left:3px solid var(--warn)}pre{white-space:pre-wrap;margin:6px 0 0;font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}ul{margin:5px 0;padding-left:20px}
@media(max-width:700px){.channels,.inbox-grid{grid-template-columns:1fr}.item header{display:block}.photos{max-width:100%;margin-top:10px}}
</style></head><body><main><h1>SecondLife sales</h1><div class="muted small">Read-only · refreshes every 5 seconds · ${esc(new Date().toLocaleString())}</div><h2>Items</h2>${itemCards()}<h2>Buyer inbox</h2>${buyerInbox()}</main></body></html>`;
}

function photoPath(url: string): string | null {
  const match = /^\/photos\/([^/]+)\/([^/]+)$/.exec(new URL(url, "http://localhost").pathname);
  if (!match) return null;
  try {
    const item = decodeURIComponent(match[1]);
    const photo = decodeURIComponent(match[2]);
    if (item !== basename(item) || photo !== basename(photo) || !/^.+\.(?:jpe?g|png)$/i.test(photo)) return null;
    const root = resolve(INTAKE);
    const path = resolve(root, item, photo);
    if (!path.startsWith(root + sep) || !existsSync(path) || !statSync(path).isFile()) return null;
    const state = readObject(join(root, item, "state.json"));
    if (!state || !array(state.photos).includes(photo)) return null;
    return path;
  } catch { return null; }
}

function sendPhoto(path: string, res: ServerResponse) {
  res.writeHead(200, { "content-type": extname(path).toLowerCase() === ".png" ? "image/png" : "image/jpeg", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(readFileSync(path));
}

createServer((req, res) => {
  const path = photoPath(req.url ?? "/");
  if (path) { sendPhoto(path, res); return; }
  if (req.url !== "/") { res.writeHead(404, { "content-type": "text/plain" }).end("not found"); return; }
  try {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }).end(render());
  } catch (error) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" }).end(`dashboard error: ${error instanceof Error ? error.message : String(error)}`);
  }
}).listen(PORT, "127.0.0.1", () => console.log(`SecondLife dashboard: http://127.0.0.1:${PORT}`));
