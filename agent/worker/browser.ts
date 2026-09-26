// The local Chrome that acts on Vinted with the seller's login. Shared by the inbox tool and the draft pipeline.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { localBrowser, Stagehand, type Page, type StagehandBrowser } from "@browserbasehq/stagehand";
import { z } from "zod/v4";
import { AGENT_DIR, KEY, sleep } from "./lib.ts";

export const PROFILE = join(AGENT_DIR, "worker", "chrome-profile");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export const humanPause = () => sleep(2000 + Math.random() * 3000); // ponytail: fixed 2-5 s jitter, tune if Vinted flags it

// A Chrome left running on the worker profile (a crashed or killed run) makes every new launch hand
// off to it and exit with code 0. Stop only processes started with this profile, then launch.
function stopOrphanedChrome() {
  try { execFileSync("pkill", ["-f", PROFILE]); } catch { /* none running */ }
}

export async function openBrowser() {
  let browser;
  try {
    browser = await localBrowser.launch({ userDataDir: PROFILE, headless: false, executablePath: CHROME });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    if (!/exited before its debugging port was ready/.test(message)) throw e;
    stopOrphanedChrome();
    await sleep(3000);
    browser = await localBrowser.launch({ userDataDir: PROFILE, headless: false, executablePath: CHROME });
  }
  const stagehand = await Stagehand.create({
    browser,
    model: { modelName: "anthropic/claude-sonnet-5", apiKey: KEY },
  });
  const [page] = await browser.context.pages();
  return { browser, stagehand, page };
}
export type Hands = { browser: StagehandBrowser; stagehand: Stagehand; page: Page };

export async function blockedReason(h: Hands): Promise<string | null> {
  const url = await h.page.url();
  if (/login|signup|member\/general\/login|session/i.test(url)) return "login_required";
  const { data } = await h.stagehand.extract(
    "Is this page a CAPTCHA, a bot check, an 'unusual activity' warning, or a sign-in form?",
    z.object({ blocked: z.boolean(), kind: z.string() }),
  );
  if (!data.blocked) return null;
  return /sign|log/i.test(data.kind) ? "login_required" : "blocked";
}
