// Local hands for seller_agent: runs the vinted_browser custom tool in a dedicated
// Chrome profile on this machine and answers the managed agent's requires_action.
//   npx tsx worker.ts login          one-time: sign in to Vinted in the worker profile
//   npx tsx worker.ts inbox [max]    start a seller_agent inbox session and serve its tool calls
//   npx tsx worker.ts watch          photo intake for the iPhone Shortcut + research → listing → Vinted draft
import { createInterface } from "node:readline/promises";
import { z } from "zod/v4";
import { CONSOLE, api, env, fetchOutputs, sleep, startSession } from "./lib.ts";
import { PROFILE, blockedReason, humanPause, openBrowser, type Hands } from "./browser.ts";
import { watch } from "./pipeline.ts";

const INBOX = "https://www.vinted.co.uk/inbox";

const ThreadList = z.object({
  threads: z.array(z.object({ thread_url: z.string(), buyer: z.string(), unread: z.boolean() })),
});
const Thread = z.object({
  buyer: z.string(),
  listing_title: z.string(),
  messages: z.array(z.object({ from: z.enum(["buyer", "seller"]), text: z.string() })),
  offer_gbp: z.number().nullable(),
});

async function readInbox(h: Hands, max: number) {
  await h.page.goto(INBOX);
  await humanPause();
  const why = await blockedReason(h);
  if (why) return { error: why, detail: await h.page.url() };
  const { data } = await h.stagehand.extract(
    "List every conversation in the inbox with its absolute URL, the other user's name, and whether it is marked unread.",
    ThreadList,
  );
  const unread = data.threads.filter((t) => t.unread).slice(0, Math.min(Math.max(max, 1), 5));
  const out = [];
  for (const t of unread) {
    await h.page.goto(t.thread_url);
    await humanPause();
    const { data: th } = await h.stagehand.extract(
      "Extract this conversation: the buyer's name, the title of the item it is about, every message in order " +
        "(from = 'seller' for messages sent by the account owner, 'buyer' otherwise), and the amount in GBP of any offer card (null if none).",
      Thread,
    );
    out.push({ thread_url: t.thread_url, ...th });
  }
  return out;
}

async function typeReply(h: Hands, threadUrl: string, text: string) {
  if (!threadUrl.startsWith("https://www.vinted.co.uk/")) return { error: "not_found", detail: "thread_url must be a vinted.co.uk URL" };
  await h.page.goto(threadUrl);
  await humanPause();
  const why = await blockedReason(h);
  if (why) return { error: why, detail: await h.page.url() };
  const { data } = await h.stagehand.observe("find the text input where a new message is written");
  if (!data.length) return { error: "not_found", detail: "no message box on the page" };
  // fill() only sets the text. Nothing here presses Enter or clicks Send.
  await h.page.locator(data[0].selector).fill(text);
  return { typed: true, note: "Typed, not sent. The seller reviews and presses Send." };
}

async function runTool(h: Hands, input: any) {
  try {
    if (input.action === "read_inbox") return await readInbox(h, input.max_threads ?? 3);
    if (input.action === "type_reply") return await typeReply(h, String(input.thread_url ?? ""), String(input.text ?? ""));
    return { error: "not_found", detail: `unknown action ${input.action}` };
  } catch (e: any) {
    return { error: "blocked", detail: String(e?.message ?? e).slice(0, 300) };
  }
}

async function login() {
  const h = await openBrowser();
  await h.page.goto("https://www.vinted.co.uk/");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question("Sign in to Vinted in the opened Chrome window, then press Enter here. ");
  rl.close();
  await h.stagehand.close();
  await h.browser.close();
  console.log(`Saved. The worker profile lives in ${PROFILE}`);
}

async function inbox(max: number) {
  const task =
    `Check the seller's Vinted inbox. Call vinted_browser read_inbox with max_threads ${max}. ` +
    "For each thread, match it to an item in memory, draft the reply within policy.md, write the outbox payloads, " +
    "update items/<item_id>/thread.md, then call vinted_browser type_reply with the exact reply text. Do not rebuild listings.";
  const session = { id: await startSession({ kind: "inbox", item: "vinted", agentId: env.SELLER_ID, agentVersion: env.SELLER_VERSION, task, rubricFile: "outcome-reply.md" }) };
  console.log(`✅ ▶️ run started ${session.id} ${CONSOLE}/sessions/${session.id}`);

  let h: Hands | null = null; // browser opens on the first tool call only
  const answered = new Set<string>();
  const deadline = Date.now() + 45 * 60_000;
  try {
    while (Date.now() < deadline) {
      const s = await api("GET", `/sessions/${session.id}`);
      if (s.status === "terminated") { console.log("terminated"); break; }
      if (s.status === "idle") {
        const ev = await api("GET", `/sessions/${session.id}/events?types[]=agent.custom_tool_use&limit=100`);
        const pending = (ev.data ?? []).filter((e: any) => !answered.has(e.id));
        if (!pending.length) {
          const last = (s.outcome_evaluations ?? []).at(-1);
          console.log(`done: ${last?.result ?? "no verdict"} ${(last?.explanation ?? "").slice(0, 400)}`);
          console.log(`fetched ${(await fetchOutputs(session.id)).length} output files into runs/${session.id}/`);
          break;
        }
        h ??= await openBrowser();
        for (const e of pending) {
          console.log(`🛠️ vinted_browser ${e.input?.action}`);
          const result = await runTool(h, e.input ?? {});
          await api("POST", `/sessions/${session.id}/events`, {
            events: [{ type: "user.custom_tool_result", custom_tool_use_id: e.id, content: [{ type: "text", text: JSON.stringify(result) }] }],
          });
          answered.add(e.id);
        }
      }
      await sleep(5000);
    }
  } finally {
    if (h) {
      await h.stagehand.close(); // leave Chrome open so the typed drafts stay visible
      console.log("Chrome stays open with the typed drafts. Review, press Send yourself, then Ctrl-C here.");
    }
  }
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "login") await login();
else if (cmd === "inbox") await inbox(Number(arg ?? 3));
else if (cmd === "watch") await watch();
else { console.error("usage: npx tsx worker.ts login | inbox [max 1-5] | watch"); process.exit(2); }
