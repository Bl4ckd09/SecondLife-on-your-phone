import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod/v4";

const policy = z.object({
  floor_ratio: z.number(),
  accept_ratio: z.number(),
  min_price_gbp: z.number(),
  max_price_gbp: z.number(),
}).parse(JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "policy.json"), "utf8")));

const money = (n: number) => Math.round(n * 100) / 100;

export function floorGbp(listed: number): number {
  return money(listed * policy.floor_ratio);
}

export function acceptLineGbp(listed: number): number {
  return Math.floor(listed * policy.accept_ratio);
}

export function checkPublish(input: unknown): string | null {
  if (!input || typeof input !== "object") return "listing input is missing";
  const price = Number("price_gbp" in input ? input.price_gbp : NaN);
  if (!Number.isFinite(price) || price < policy.min_price_gbp || price > policy.max_price_gbp) {
    return `price_gbp must be between £${policy.min_price_gbp} and £${policy.max_price_gbp}`;
  }
  const title = "title" in input ? input.title : undefined;
  if (typeof title !== "string" || title.length > 80) return "title must be at most 80 characters";
  const bestOffer = "best_offer" in input && input.best_offer && typeof input.best_offer === "object" ? input.best_offer : {};
  const decline = Number("auto_decline_gbp" in bestOffer ? bestOffer.auto_decline_gbp : NaN);
  const accept = Number("auto_accept_gbp" in bestOffer ? bestOffer.auto_accept_gbp : NaN);
  if (!Number.isFinite(decline) || decline < Math.floor(floorGbp(price))) {
    return `auto_decline_gbp must be at least £${Math.floor(floorGbp(price))}`;
  }
  if (!Number.isFinite(accept) || accept < decline || accept > price) {
    return "auto_accept_gbp must be at least auto_decline_gbp and no more than price_gbp";
  }
  return null;
}

export function checkOffer(decision: string, amount: number | undefined, listed: number): string | null {
  if (!Number.isFinite(listed) || listed <= 0) return "listed price is missing";
  if (decision === "decline") return null;
  if (decision !== "accept" && decision !== "counter") return "decision must be accept, decline or counter";
  if (!Number.isFinite(amount)) return `${decision} amount is missing`;
  if (amount! < floorGbp(listed)) return `${decision} amount is below the seller floor`;
  if (decision === "counter" && amount! > listed) return "counter amount is above the list price";
  return null;
}

export function checkReplyText(text: string): string | null {
  if (typeof text !== "string" || text.length > 2000) return "reply must be at most 2000 characters";
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)) return "reply contains an email address";
  if (/(?:\+?\d[\s().-]*){9,}/.test(text)) return "reply contains a phone number";
  if (/\b(?:paypal|bank transfer|whatsapp|venmo|revolut|cash on collection)\b/i.test(text)) return "reply proposes off-platform contact or payment";
  const urls = text.match(/\b(?:https?:\/\/|www\.)?[a-z0-9](?:[a-z0-9-]*\.)+[a-z]{2,}(?:\/[^\s<]*)?/gi) ?? [];
  for (const raw of urls) {
    try {
      const host = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase();
      if (host !== "ebay.co.uk" && !host.endsWith(".ebay.co.uk") && host !== "ebay.com" && !host.endsWith(".ebay.com")) {
        return "reply contains an off-eBay URL";
      }
    } catch {
      return "reply contains an invalid URL";
    }
  }
  return null;
}
