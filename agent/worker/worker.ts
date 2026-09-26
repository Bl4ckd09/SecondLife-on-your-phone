import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { appToken, consentUrl, exchangeCode, rest, userToken } from "./ebay.ts";
import { AGENT_DIR, env } from "./lib.ts";
import { runInboxOnce, watch } from "./pipeline.ts";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function array(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string {
  return String(value ?? "");
}

async function login() {
  console.log(consentUrl());
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const pasted = (await prompt.question("Paste the redirected URL or authorization code: ")).trim();
  prompt.close();
  let code = pasted;
  try { code = new URL(pasted).searchParams.get("code") || pasted; } catch { /* raw code */ }
  if (!code) throw new Error("auth: authorization code is empty");
  await exchangeCode(code);
  console.log("Saved agent/.ebay-token.json with mode 0600.");
}

async function firstOrCreate(path: string, collection: string, idField: string, body: unknown): Promise<string> {
  const existing = record(await rest("GET", path, { query: { marketplace_id: "EBAY_GB" } }));
  const first = record(array(existing[collection])[0]);
  let id = text(first[idField]);
  if (!id) id = text(record(await rest("POST", path, { body }))[idField]);
  if (!id) throw new Error(`ebay: ${path} returned no ${idField}`);
  return id;
}

async function setup() {
  const programs = record(await rest("GET", "/sell/account/v1/program/get_opted_in_programs"));
  const optedIn = array(programs.programs).some((entry) => record(entry).programType === "SELLING_POLICY_MANAGEMENT");
  if (!optedIn) await rest("POST", "/sell/account/v1/program/opt_in", { body: { programType: "SELLING_POLICY_MANAGEMENT" } });
  const categories = [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES", default: true }];
  const fulfillmentPolicyId = await firstOrCreate(
    "/sell/account/v1/fulfillment_policy",
    "fulfillmentPolicies",
    "fulfillmentPolicyId",
    {
      name: "SecondLife UK tracked",
      description: "UK tracked delivery, dispatched within two working days",
      marketplaceId: "EBAY_GB",
      categoryTypes: categories,
      handlingTime: { value: 2, unit: "DAY" },
      globalShipping: false,
      shippingOptions: [{
        optionType: "DOMESTIC",
        costType: "FLAT_RATE",
        shippingServices: [{
          sortOrder: 1,
          shippingServiceCode: "UK_RoyalMailTracked",
          shippingCost: { value: "3.20", currency: "GBP" },
        }],
      }],
    },
  );
  const paymentPolicyId = await firstOrCreate(
    "/sell/account/v1/payment_policy",
    "paymentPolicies",
    "paymentPolicyId",
    {
      name: "SecondLife immediate payment",
      description: "Immediate payment through eBay",
      marketplaceId: "EBAY_GB",
      categoryTypes: categories,
      immediatePay: true,
    },
  );
  const returnPolicyId = await firstOrCreate(
    "/sell/account/v1/return_policy",
    "returnPolicies",
    "returnPolicyId",
    {
      name: "SecondLife 30 day returns",
      description: "30 day returns; buyer pays return postage",
      marketplaceId: "EBAY_GB",
      categoryTypes: categories,
      returnsAccepted: true,
      returnPeriod: { value: 30, unit: "DAY" },
      returnShippingCostPayer: "BUYER",
      refundMethod: "MONEY_BACK",
    },
  );
  if (!env.EBAY_POSTCODE) throw new Error("auth: EBAY_POSTCODE missing in agent/.env");
  const locationPath = "/sell/inventory/v1/location/secondlife";
  const location = {
    location: { address: { postalCode: env.EBAY_POSTCODE, country: "GB" } },
    locationTypes: ["WAREHOUSE"],
    name: "SecondLife",
    merchantLocationStatus: "ENABLED",
  };
  try {
    await rest("GET", locationPath);
  } catch (error) {
    if (!(error instanceof Error) || !/^ebay: HTTP 404(?: |$)/.test(error.message)) throw error;
    await rest("POST", locationPath, { body: location });
  }
  const path = join(AGENT_DIR, ".ebay-setup.json");
  writeFileSync(path, JSON.stringify({ fulfillmentPolicyId, paymentPolicyId, returnPolicyId }, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
  console.log(`Saved ${path} and inventory location secondlife.`);
}

async function check() {
  await appToken();
  const result = record(await rest("GET", "/buy/browse/v1/item_summary/search", { token: "app", query: { q: "levis 501", limit: 3 } }));
  for (const item of array(result.itemSummaries).slice(0, 3)) console.log(text(record(item).title));
  await userToken();
  console.log("eBay app and user tokens OK.");
}

const [command] = process.argv.slice(2);
if (command === "login") await login();
else if (command === "setup") await setup();
else if (command === "check") await check();
else if (command === "inbox") await runInboxOnce();
else if (command === "watch") await watch();
else {
  console.error("usage: npx tsx worker.ts login | setup | check | inbox | watch");
  process.exitCode = 2;
}
