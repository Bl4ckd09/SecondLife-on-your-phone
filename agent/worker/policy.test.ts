import assert from "node:assert/strict";
import { acceptLineGbp, checkOffer, checkPublish, checkReplyText, floorGbp } from "./policy.ts";

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

console.log("policy checks passed");
