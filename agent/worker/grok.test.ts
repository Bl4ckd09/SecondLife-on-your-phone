import assert from "node:assert/strict";
import { mappedCondition } from "./grok.ts";

const policies = ["NEW", "NEW_OTHER", "PRE_OWNED_EXCELLENT", "USED_EXCELLENT", "PRE_OWNED_FAIR"].map((value) => ({ enum: value }));
assert.deepEqual(
  ["pre-owned excellent", "pre-owned good", "pre-owned fair", "new with tags", "new without tags"].map((value) => mappedCondition(value, policies)),
  ["PRE_OWNED_EXCELLENT", "USED_EXCELLENT", "PRE_OWNED_FAIR", "NEW", "NEW_OTHER"],
);
assert.equal(mappedCondition("unknown", [{ enum: "USED_GOOD" }]), "USED_GOOD");
assert.throws(() => mappedCondition("unknown", []), /no supported condition enum/);

console.log("grok tests passed");
