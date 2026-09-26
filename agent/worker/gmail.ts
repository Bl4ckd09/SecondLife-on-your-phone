import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import { RUNS, env } from "./lib.ts";

const SEEN_FILE = join(RUNS, "vinted-mail-seen.json");

export type VintedNotification = {
  uid: number;
  buyer: string;
  listing: string;
  message: string;
  offer_gbp?: number;
};

function seenUids(): Set<number> {
  if (!existsSync(SEEN_FILE)) return new Set();
  try {
    const saved = JSON.parse(readFileSync(SEEN_FILE, "utf8"));
    if (!Array.isArray(saved)) return new Set();
    return new Set(saved.map(Number).filter(Number.isSafeInteger));
  } catch {
    return new Set();
  }
}

export function markVintedMailSeen(uid: number) {
  const seen = seenUids();
  seen.add(uid);
  mkdirSync(RUNS, { recursive: true });
  writeFileSync(SEEN_FILE, JSON.stringify([...seen].sort((a, b) => a - b), null, 2));
}

export function parseVintedNotification(uid: number, mail: ParsedMail): VintedNotification | null {
  const subject = String(mail.subject ?? "").trim();
  const html = typeof mail.html === "string"
    ? mail.html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ")
    : "";
  const body = String(mail.text ?? html).replace(/\r/g, "").replace(/[ \t]+/g, " ").trim();
  const context = `${subject}\n${body.slice(0, 3000)}`;
  const buyerSignal = /\bnew (?:message|offer)\b|\b(?:message|offer) from\b|\bsent you (?:a |an )?(?:new )?(?:message|offer)\b|\bmade (?:you )?an offer\b/i;
  const nonMessage = /\b(?:newsletter|recommended for you|price drop|wardrobe spotlight|your payout|payout (?:is|has|was)|you sold|item (?:was|has been) sold|sale confirmation|shipping label|tracking update|order (?:was|has been) (?:shipped|delivered)|parcel (?:was|has been) (?:sent|shipped|delivered))\b/i;
  const bodySignalAt = body.search(buyerSignal);
  const beforeBuyerMessage = bodySignalAt >= 0 ? body.slice(0, bodySignalAt) : body.slice(0, 700);
  if (!buyerSignal.test(context) || nonMessage.test(subject) || nonMessage.test(beforeBuyerMessage)) return null;

  let buyer = "";
  for (const pattern of [
    /(?:new (?:message|offer)|message|offer) from\s+["“]?([^"”\n:<]{1,80})/i,
    /([^<>\n:]{1,80})\s+(?:sent you (?:a |an )?(?:new )?(?:message|offer)|made (?:you )?an offer)/i,
  ]) {
    const match = context.match(pattern);
    if (match) {
      buyer = match[1].replace(/^member\s+/i, "").replace(/[.!]+$/, "").trim();
      break;
    }
  }

  let listing = "";
  for (const pattern of [
    /(?:about|regarding)\s+(?:your\s+)?(?:item|listing)?\s*["“]([^"”\n]{2,160})["”]/i,
    /(?:item|listing)(?:\s+title)?\s*:\s*["“]?([^"”\n]{2,160})/i,
  ]) {
    const match = body.match(pattern);
    if (match) {
      listing = match[1].trim();
      break;
    }
  }

  const labelled = body.match(/(?:message|wrote|said|says)\s*:\s*(?:\n+|["“])([\s\S]{1,1500}?)(?=\n(?:view|reply|open|go to|download|manage|unsubscribe|privacy|help|this email|the vinted team)\b|$)/i);
  let message = labelled?.[1]?.trim() ?? "";
  if (!message) {
    const lines = body.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    const signalLine = lines.findIndex((line) => buyerSignal.test(line));
    const candidates = (signalLine >= 0 ? lines.slice(signalLine + 1) : lines).filter((line) =>
      line !== subject
      && !/^(?:https?:\/\/|view\b|reply\b|open\b|go to\b|download\b|manage\b|unsubscribe\b|privacy\b|help centre\b|this email\b|you received this email\b|the vinted team\b|vinted\s*[©®]?\s*$)/i.test(line)
      && !/^(?:item|listing)(?:\s+title)?\s*:/i.test(line)
      && !buyerSignal.test(line),
    );
    message = candidates.join("\n").trim();
  }
  message = message.replace(/^["“]|["”]$/g, "").trim().slice(0, 1000);
  if (!message) return null;

  const amount = /offer/i.test(context)
    ? context.match(/(?:offer(?:ed)?(?:\s+(?:you|of|is|for))?|made (?:you )?an offer(?: of)?)\s*:?\s*£\s*(\d+(?:[.,]\d{1,2})?)/i)
      ?? context.match(/£\s*(\d+(?:[.,]\d{1,2})?)/)
    : null;
  const offerGbp = amount ? Number(amount[1].replace(",", ".")) : undefined;
  return {
    uid,
    buyer,
    listing,
    message,
    ...(Number.isFinite(offerGbp) ? { offer_gbp: offerGbp } : {}),
  };
}

export async function fetchVintedNotifications(): Promise<VintedNotification[]> {
  if (!env.VINTED_EMAIL || !env.VINTED_EMAIL_APP_PASSWORD) {
    throw new Error("VINTED_EMAIL and VINTED_EMAIL_APP_PASSWORD are missing");
  }

  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: env.VINTED_EMAIL, pass: env.VINTED_EMAIL_APP_PASSWORD },
    logger: false,
  });
  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX", { readOnly: true });
    try {
      const since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      const found = await client.search({ from: "vinted", since }, { uid: true });
      const seen = seenUids();
      const uids = Array.isArray(found) ? found.filter((uid) => !seen.has(uid)) : [];
      if (!uids.length) return [];

      const notifications: VintedNotification[] = [];
      for await (const message of client.fetch(uids, { source: true }, { uid: true })) {
        if (!message.source) continue;
        try {
          const notification = parseVintedNotification(message.uid, await simpleParser(message.source));
          if (notification) notifications.push(notification);
        } catch (error) {
          console.warn(`vinted mail ${message.uid}: ${error instanceof Error ? error.message : error}`);
        }
      }
      return notifications;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => client.close());
  }
}
