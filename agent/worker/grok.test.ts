import assert from "node:assert/strict";
import { grokSellerAction, mappedCondition } from "./grok.ts";

const policies = ["NEW", "NEW_OTHER", "PRE_OWNED_EXCELLENT", "USED_EXCELLENT", "PRE_OWNED_FAIR"].map((value) => ({ enum: value }));
assert.deepEqual(
  ["pre-owned excellent", "pre-owned good", "pre-owned fair", "new with tags", "new without tags"].map((value) => mappedCondition(value, policies)),
  ["PRE_OWNED_EXCELLENT", "USED_EXCELLENT", "PRE_OWNED_FAIR", "NEW", "NEW_OTHER"],
);
assert.equal(mappedCondition("unknown", [{ enum: "USED_GOOD" }]), "USED_GOOD");
assert.throws(() => mappedCondition("unknown", []), /no supported condition enum/);

assert.deepEqual(
  grokSellerAction({ kind: "question", ebay_ref: "message-1", response: { action: "reply", text: "Yes, it is." } }),
  { action: "reply", message_id: "message-1", text: "Yes, it is." },
);
assert.deepEqual(
  grokSellerAction({ kind: "offer", ebay_ref: "offer-1", listing_id: "listing-1", response: { action: "counter", counter_gbp: 24, text: "I can do £24." } }),
  { action: "respond_offer", offer_id: "offer-1", listing_id: "listing-1", decision: "counter", counter_gbp: 24, text: "I can do £24." },
);
assert.throws(
  () => grokSellerAction({ kind: "offer", ebay_ref: "offer-1", listing_id: "listing-1", response: { action: "reply", text: "No." } }),
  /policy: an offer requires/,
);

console.log("grok tests passed");
