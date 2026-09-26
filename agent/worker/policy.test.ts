import assert from "node:assert/strict";
import { simpleParser } from "mailparser";
import { acceptLineGbp, checkOffer, checkPublish, checkReplyText, floorGbp } from "./policy.ts";
import { dispatchTool } from "./pipeline.ts";
import { env } from "./lib.ts";
import { parseVintedNotification } from "./gmail.ts";

assert.equal(floorGbp(19.99), 15.99);
assert.equal(acceptLineGbp(19.99), 18);
assert.match(checkOffer("accept", 15, 20) ?? "", /below/);
assert.match(checkOffer("counter", 15, 20) ?? "", /below/);
assert.equal(checkOffer("counter", 35, 40), null);
const validListing = { title: "Levi 501 W32 L32 blue", price_gbp: 40, best_offer: { auto_accept_gbp: 36, auto_decline_gbp: 32 } };
assert.match(checkPublish({ ...validListing, best_offer: { ...validListing.best_offer, auto_decline_gbp: 31 } }) ?? "", /auto_decline_gbp/);
assert.match(checkPublish({ ...validListing, title: "x".repeat(81) }) ?? "", /title/);
assert.equal(checkPublish(validListing), null);
assert.match(checkReplyText("Email me at buyer@example.org") ?? "", /email/);
assert.match(checkReplyText("Pay by bank transfer at https://example.org") ?? "", /off-platform/);
assert.equal(checkReplyText("Yes, it is still available. Thanks"), null);
const offerMail = await simpleParser(Buffer.from([
  "From: Vinted <no-reply@vinted.co.uk>",
  "Subject: New offer from wardrobe_buyer",
  "",
  "wardrobe_buyer made you an offer about \"Levi 501 jeans\"",
  "Offer: £18.50",
  "View offer",
].join("\r\n")));
assert.deepEqual(parseVintedNotification(42, offerMail), {
  uid: 42,
  buyer: "wardrobe_buyer",
  listing: "Levi 501 jeans",
  message: "Offer: £18.50",
  offer_gbp: 18.5,
});

assert.deepEqual(await dispatchTool({ kind: "research", item: "item-a" }, "unknown", {}), { error: "not_found" });
const tavilyKey = env.TAVILY_API_KEY;
delete env.TAVILY_API_KEY;
assert.deepEqual(await dispatchTool({ kind: "research", item: "item-a" }, "web_search", { query: "coat" }), { error: "auth" });
assert.deepEqual(await dispatchTool({ kind: "listing", item: "item-a" }, "web_search", { query: "coat" }), { error: "auth" });
assert.deepEqual(await dispatchTool({ kind: "vinted", item: "item-a" }, "web_search", { query: "coat" }), { error: "auth" });
if (tavilyKey) env.TAVILY_API_KEY = tavilyKey;
assert.deepEqual(await dispatchTool({ kind: "inbox" }, "web_search", { query: "coat" }), {
  error: "policy",
  detail: "web_search is only available to research, listing, and vinted sessions",
});
assert.deepEqual(await dispatchTool({ kind: "research", item: "item-a" }, "ebay_seller", {}), {
  error: "policy",
  detail: "research sessions may only use ebay_research and web_search",
});
assert.deepEqual(await dispatchTool({ kind: "listing", item: "item-a" }, "ebay_seller", { action: "publish_listing", item_id: "item-b" }), {
  error: "policy",
  detail: "listing sessions may only publish item item-a",
});
assert.deepEqual(await dispatchTool({ kind: "inbox" }, "ebay_seller", { action: "publish_listing" }), {
  error: "policy",
  detail: "inbox sessions may not publish listings",
});
assert.deepEqual(await dispatchTool({ kind: "none" }, "ebay_research", {}), {
  error: "policy",
  detail: "this session may not use custom tools",
});

console.log("policy checks passed");
