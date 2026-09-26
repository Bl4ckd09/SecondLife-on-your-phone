import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod/v4";
import { ebayEnvironment, rest, trading, uploadPicture, xmlEscape } from "./ebay.ts";
import { AGENT_DIR, RUNS } from "./lib.ts";
import { checkOffer, checkPublish, checkReplyText, floorGbp } from "./policy.ts";

const INTAKE = join(RUNS, "intake");
const SEEN_FILE = join(RUNS, "ebay-seen.json");
const ItemState = z.object({
  item: z.string(),
  status: z.string(),
  photos: z.array(z.string()).default([]),
  title: z.string().optional(),
  listingId: z.string().optional(),
  listedGbp: z.number().optional(),
  url: z.string().optional(),
}).loose();
const Setup = z.object({
  fulfillmentPolicyId: z.string(),
  paymentPolicyId: z.string(),
  returnPolicyId: z.string(),
});
const Publish = z.object({
  action: z.literal("publish_listing"),
  item_id: z.string(),
  title: z.string(),
  description: z.string(),
  category_id: z.string(),
  condition: z.string(),
  condition_description: z.string().optional(),
  aspects: z.record(z.string(), z.array(z.string())),
  price_gbp: z.number(),
  best_offer: z.object({ auto_accept_gbp: z.number(), auto_decline_gbp: z.number() }),
});
const Reply = z.object({ action: z.literal("reply"), message_id: z.string(), text: z.string() });
const OfferResponse = z.object({
  action: z.literal("respond_offer"),
  offer_id: z.string(),
  listing_id: z.string(),
  decision: z.enum(["accept", "decline", "counter"]),
  counter_gbp: z.number().optional(),
  text: z.string().optional(),
});

type State = z.infer<typeof ItemState>;
type ErrorResult = { error: "auth" | "ebay" | "policy" | "not_found"; detail: string };
type MessageContext = { listingId: string; itemId: string; buyer: string };
type OfferContext = { listingId: string; itemId: string; amount: number };

const inboxMessages = new Map<string, MessageContext>();
const inboxOffers = new Map<string, OfferContext>();
export const delivered = new Set<string>();

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function array(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown, max = 200): string {
  return String(value ?? "").slice(0, max);
}

function amount(value: unknown): number {
  const source = record(value);
  return Number(source["#text"] ?? source.value ?? value);
}

function fail(error: unknown): ErrorResult {
  const message = error instanceof Error ? error.message : String(error);
  const match = /^(auth|ebay|policy|not_found):\s*(.*)$/s.exec(message);
  const kind = match?.[1] as ErrorResult["error"] | undefined;
  return { error: kind ?? "ebay", detail: text(match?.[2] ?? message, 400) };
}

function safeItem(item: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(item)) throw new Error("not_found: invalid item id");
  return item;
}

function statePath(item: string): string {
  return join(INTAKE, safeItem(item), "state.json");
}

function loadState(item: string): State {
  const path = statePath(item);
  if (!existsSync(path)) throw new Error(`not_found: item ${item} does not exist`);
  try { return ItemState.parse(JSON.parse(readFileSync(path, "utf8"))); } catch { throw new Error(`not_found: item ${item} has invalid local state`); }
}

function liveStates(): State[] {
  if (!existsSync(INTAKE)) return [];
  const states: State[] = [];
  for (const item of readdirSync(INTAKE).sort()) {
    const path = join(INTAKE, item, "state.json");
    if (!existsSync(path)) continue;
    try {
      const state = ItemState.parse(JSON.parse(readFileSync(path, "utf8")));
      if (state.status === "live" && state.listingId && state.listedGbp !== undefined) states.push(state);
    } catch { /* another item remains usable */ }
  }
  return states;
}

function listingSummary(value: unknown) {
  const item = record(value);
  const price = record(item.price);
  const shipping = record(record(array(item.shippingOptions)[0]).shippingCost);
  const seller = record(item.seller);
  return {
    item_id: text(item.itemId, 120),
    title: text(item.title, 160),
    price_gbp: Number(price.value),
    shipping_gbp: shipping.value === undefined ? null : Number(shipping.value),
    condition: text(item.condition, 80),
    seller_feedback: seller.feedbackPercentage === undefined ? null : Number(seller.feedbackPercentage),
    url: text(item.itemWebUrl, 300),
  };
}

async function researchAction(itemId: string, input: Record<string, unknown>): Promise<unknown> {
  const action = text(input.action, 40);
  const limit = Math.min(50, Math.max(1, Number(input.limit ?? 20) || 20));
  if (action === "search") {
    const q = text(input.q, 200);
    if (!q) throw new Error("not_found: q is required");
    const query: Record<string, string | number | undefined> = { q, limit };
    if (input.category_id) query.category_ids = text(input.category_id, 30);
    if (input.condition === "new" || input.condition === "used") query.filter = `conditions:{${String(input.condition).toUpperCase()}}`;
    const data = record(await rest("GET", "/buy/browse/v1/item_summary/search", { token: "app", query }));
    return { total: Number(data.total ?? 0), items: array(data.itemSummaries).slice(0, limit).map(listingSummary) };
  }
  if (action === "search_by_image") {
    const photo = text(input.photo, 120);
    if (!photo || photo.includes("/") || photo.includes("..") || basename(photo) !== photo) throw new Error("not_found: invalid photo name");
    const path = join(INTAKE, safeItem(itemId), photo);
    if (!existsSync(path)) throw new Error(`not_found: photo ${photo} does not exist`);
    const data = record(await rest("POST", "/buy/browse/v1/item_summary/search_by_image", {
      token: "app",
      body: { image: readFileSync(path).toString("base64") },
      query: { limit },
    }));
    return { total: Number(data.total ?? 0), items: array(data.itemSummaries).slice(0, limit).map(listingSummary) };
  }
  if (action === "get_item") {
    const id = text(input.item_id, 160);
    if (!id) throw new Error("not_found: item_id is required");
    const data = record(await rest("GET", `/buy/browse/v1/item/${encodeURIComponent(id)}`, { token: "app" }));
    return {
      item_id: text(data.itemId, 120),
      title: text(data.title, 160),
      price_gbp: Number(record(data.price).value),
      condition: text(data.condition, 80),
      aspects: array(data.localizedAspects).slice(0, 40).map((aspect) => ({ name: text(record(aspect).name, 80), value: text(record(aspect).value, 160) })),
      short_description: text(data.shortDescription, 1000),
      url: text(data.itemWebUrl, 300),
    };
  }
  if (action === "category_suggestions") {
    const q = text(input.q, 200);
    if (!q) throw new Error("not_found: q is required");
    const tree = record(await rest("GET", "/commerce/taxonomy/v1/get_default_category_tree_id", { token: "app", query: { marketplace_id: "EBAY_GB" } }));
    const treeId = text(tree.categoryTreeId, 30);
    const data = record(await rest("GET", `/commerce/taxonomy/v1/category_tree/${encodeURIComponent(treeId)}/get_category_suggestions`, { token: "app", query: { q } }));
    return array(data.categorySuggestions).slice(0, 20).map((entry) => {
      const suggestion = record(entry);
      const category = record(suggestion.category);
      const names = array(suggestion.categoryTreeNodeAncestors).map((ancestor) => text(record(record(ancestor).category).categoryName, 100)).filter(Boolean);
      names.push(text(category.categoryName, 100));
      return { category_id: text(category.categoryId, 30), path: names.join(" > ") };
    });
  }
  if (action === "item_aspects") {
    const categoryId = text(input.category_id, 30);
    if (!categoryId) throw new Error("not_found: category_id is required");
    const tree = record(await rest("GET", "/commerce/taxonomy/v1/get_default_category_tree_id", { token: "app", query: { marketplace_id: "EBAY_GB" } }));
    const data = record(await rest("GET", `/commerce/taxonomy/v1/category_tree/${encodeURIComponent(text(tree.categoryTreeId, 30))}/get_item_aspects_for_category`, {
      token: "app", query: { category_id: categoryId },
    }));
    return array(data.aspects).map((entry) => {
      const aspect = record(entry);
      const constraint = record(aspect.aspectConstraint);
      return {
        name: text(aspect.localizedAspectName, 100),
        required: constraint.aspectRequired === true,
        values: array(aspect.aspectValues).slice(0, 30).map((value) => text(record(value).localizedValue, 100)),
      };
    }).sort((a, b) => Number(b.required) - Number(a.required)).slice(0, 25);
  }
  if (action === "condition_policies") {
    const categoryId = text(input.category_id, 30);
    if (!categoryId) throw new Error("not_found: category_id is required");
    const data = record(await rest("GET", "/sell/metadata/v1/marketplace/EBAY_GB/get_item_condition_policies", {
      token: "app", query: { filter: `categoryIds:{${categoryId}}` },
    }));
    const enums: Record<string, string> = {
      "1000": "NEW", "1500": "NEW_OTHER", "1750": "NEW_WITH_DEFECTS", "2750": "LIKE_NEW",
      "2990": "PRE_OWNED_EXCELLENT", "3000": "USED_EXCELLENT", "3010": "PRE_OWNED_FAIR",
      "4000": "USED_VERY_GOOD", "5000": "USED_GOOD", "6000": "USED_ACCEPTABLE", "7000": "FOR_PARTS_OR_NOT_WORKING",
    };
    const policies = array(data.itemConditionPolicies);
    const conditions = policies.flatMap((policy) => array(record(policy).itemConditions));
    return conditions.slice(0, 30).map((entry) => {
      const condition = record(entry);
      const id = text(condition.conditionId, 20);
      return { ...(enums[id] ? { enum: enums[id] } : {}), id, label: text(condition.conditionDescription, 100) };
    });
  }
  throw new Error(`not_found: unknown action ${action}`);
}

export async function runResearchTool(item: string, input: unknown): Promise<unknown> {
  try { return await researchAction(item, record(input)); } catch (error) { return fail(error); }
}

async function publishListing(raw: unknown) {
  let input: z.infer<typeof Publish>;
  try { input = Publish.parse(raw); } catch { throw new Error("policy: invalid publish_listing input"); }
  const reason = checkPublish(input);
  if (reason) throw new Error(`policy: ${reason}`);
  const state = loadState(input.item_id);
  if (state.listingId) throw new Error(`policy: item ${input.item_id} already has listing ${state.listingId}`);
  let setup: z.infer<typeof Setup>;
  try { setup = Setup.parse(JSON.parse(readFileSync(join(AGENT_DIR, ".ebay-setup.json"), "utf8"))); } catch { throw new Error("auth: agent/.ebay-setup.json is missing or invalid; run worker.ts setup"); }

  const imageUrls: string[] = [];
  for (const photo of state.photos) {
    if (basename(photo) !== photo || photo.includes("..")) throw new Error(`not_found: invalid local photo ${photo}`);
    imageUrls.push(await uploadPicture(join(INTAKE, state.item, photo)));
  }
  const sku = state.item;
  await rest("PUT", `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, {
    body: {
      availability: { shipToLocationAvailability: { quantity: 1 } },
      condition: input.condition,
      ...(input.condition_description ? { conditionDescription: input.condition_description } : {}),
      product: { title: input.title, description: input.description, aspects: input.aspects, imageUrls },
    },
  });
  const price = (value: number) => ({ currency: "GBP", value: value.toFixed(2) });
  const offerBody = {
    sku,
    marketplaceId: "EBAY_GB",
    format: "FIXED_PRICE",
    availableQuantity: 1,
    categoryId: input.category_id,
    listingDescription: input.description,
    pricingSummary: { price: price(input.price_gbp) },
    listingPolicies: {
      fulfillmentPolicyId: setup.fulfillmentPolicyId,
      paymentPolicyId: setup.paymentPolicyId,
      returnPolicyId: setup.returnPolicyId,
      bestOfferTerms: {
        bestOfferEnabled: true,
        autoAcceptPrice: price(input.best_offer.auto_accept_gbp),
        autoDeclinePrice: price(input.best_offer.auto_decline_gbp),
      },
    },
    merchantLocationKey: "secondlife",
  };
  const existing = record(await rest("GET", "/sell/inventory/v1/offer", { query: { sku } }));
  let offerId = text(record(array(existing.offers)[0]).offerId, 100);
  if (offerId) {
    await rest("PUT", `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`, { body: offerBody });
  } else {
    const created = record(await rest("POST", "/sell/inventory/v1/offer", { body: offerBody }));
    offerId = text(created.offerId, 100);
  }
  if (!offerId) throw new Error("ebay: create offer returned no offerId");
  const published = record(await rest("POST", `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`));
  const listingId = text(published.listingId, 100);
  if (!listingId) throw new Error("ebay: publish offer returned no listingId");
  const host = ebayEnvironment === "production" ? "www.ebay.co.uk" : "www.sandbox.ebay.co.uk";
  const url = `https://${host}/itm/${encodeURIComponent(listingId)}`;
  writeFileSync(statePath(state.item), JSON.stringify({ ...state, title: input.title, listingId, listedGbp: input.price_gbp, url }, null, 2));
  return { listing_id: listingId, url };
}

function seenIds(): Set<string> {
  if (!existsSync(SEEN_FILE)) return new Set();
  try { return new Set(z.array(z.string()).parse(JSON.parse(readFileSync(SEEN_FILE, "utf8")))); } catch { return new Set(); }
}

async function getInbox() {
  const states = liveStates();
  const byListing = new Map(states.map((state) => [state.listingId!, state]));
  const seen = seenIds();
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 24 * 60 * 60_000);
  const headers = await trading("GetMyMessages",
    `<DetailLevel>ReturnHeaders</DetailLevel><FolderID>0</FolderID><StartTime>${start.toISOString()}</StartTime><EndTime>${end.toISOString()}</EndTime>` +
    "<Pagination><EntriesPerPage>100</EntriesPerPage><PageNumber>1</PageNumber></Pagination>");
  const messageHeaders = array(record(headers.Messages).Message).map(record).filter((message) => {
    const unread = message.Read !== true && text(message.Read, 10).toLowerCase() !== "true";
    return unread && text(message.MessageType, 80) === "AskSellerQuestion" && !seen.has(text(message.MessageID, 120));
  });
  const ids = messageHeaders.map((message) => text(message.MessageID, 120)).filter(Boolean);
  const details = ids.length ? await trading("GetMyMessages",
    `<DetailLevel>ReturnMessages</DetailLevel><MessageIDs>${ids.map((id) => `<MessageID>${xmlEscape(id)}</MessageID>`).join("")}</MessageIDs>`) : {};
  const detailById = new Map(array(record(details.Messages).Message).map((message) => {
    const value = record(message);
    return [text(value.MessageID, 120), value] as const;
  }));
  const questions = [];
  for (const header of messageHeaders) {
    const id = text(header.MessageID, 120);
    const detail = detailById.get(id) ?? header;
    const listingId = text(detail.ItemID ?? header.ItemID, 120);
    const state = byListing.get(listingId);
    if (!state) continue;
    const sender = record(detail.Sender);
    const buyer = text(sender.UserID ?? detail.Sender, 100);
    inboxMessages.set(id, { listingId, itemId: state.item, buyer });
    delivered.add(id);
    questions.push({
      message_id: id,
      listing_id: listingId,
      item_id: state.item,
      buyer,
      subject: text(detail.Subject ?? header.Subject, 160),
      text: text(detail.Text ?? detail.Body, 2000),
      listed_gbp: state.listedGbp,
      floor_gbp: floorGbp(state.listedGbp!),
    });
  }

  const offers = [];
  for (const state of states) {
    const response = await trading("GetBestOffers",
      `<ItemID>${xmlEscape(state.listingId)}</ItemID><BestOfferStatus>Active</BestOfferStatus>` +
      "<Pagination><EntriesPerPage>100</EntriesPerPage><PageNumber>1</PageNumber></Pagination>");
    for (const raw of array(record(response.BestOfferArray).BestOffer)) {
      const offer = record(raw);
      const id = text(offer.BestOfferID, 120);
      if (!id || seen.has(id)) continue;
      const buyer = record(offer.Buyer);
      const offered = amount(offer.Price);
      inboxOffers.set(id, { listingId: state.listingId!, itemId: state.item, amount: offered });
      delivered.add(id);
      offers.push({
        offer_id: id,
        listing_id: state.listingId,
        item_id: state.item,
        buyer: text(buyer.UserID, 100),
        amount_gbp: offered,
        message: text(offer.BuyerMessage, 1000),
        listed_gbp: state.listedGbp,
        floor_gbp: floorGbp(state.listedGbp!),
      });
    }
  }
  return { questions, offers };
}

async function replyToQuestion(raw: unknown) {
  let input: z.infer<typeof Reply>;
  try { input = Reply.parse(raw); } catch { throw new Error("policy: invalid reply input"); }
  const reason = checkReplyText(input.text);
  if (reason) throw new Error(`policy: ${reason}`);
  const context = inboxMessages.get(input.message_id);
  if (!context) throw new Error(`not_found: message ${input.message_id} was not returned by get_inbox`);
  await trading("AddMemberMessageRTQ",
    `<ItemID>${xmlEscape(context.listingId)}</ItemID><MemberMessage><Body>${xmlEscape(input.text)}</Body>` +
    `<ParentMessageID>${xmlEscape(input.message_id)}</ParentMessageID><RecipientID>${xmlEscape(context.buyer)}</RecipientID></MemberMessage>`);
  await trading("ReviseMyMessages", `<MessageIDs><MessageID>${xmlEscape(input.message_id)}</MessageID></MessageIDs><Read>true</Read>`);
  return { replied: true, message_id: input.message_id };
}

async function respondToOffer(raw: unknown) {
  let input: z.infer<typeof OfferResponse>;
  try { input = OfferResponse.parse(raw); } catch { throw new Error("policy: invalid respond_offer input"); }
  const context = inboxOffers.get(input.offer_id);
  if (!context || context.listingId !== input.listing_id) throw new Error(`not_found: offer ${input.offer_id} was not returned by get_inbox`);
  const state = liveStates().find((entry) => entry.listingId === input.listing_id);
  if (!state?.listedGbp) throw new Error(`not_found: live listing ${input.listing_id} has no local price`);
  const checkedAmount = input.decision === "accept" ? context.amount : input.decision === "counter" ? input.counter_gbp : undefined;
  const reason = checkOffer(input.decision, checkedAmount, state.listedGbp);
  if (reason) throw new Error(`policy: ${reason}`);
  if (input.text) {
    const textReason = checkReplyText(input.text);
    if (textReason) throw new Error(`policy: ${textReason}`);
  }
  const action = { accept: "Accept", decline: "Decline", counter: "Counter" }[input.decision];
  const counter = input.decision === "counter" ? `<CounterOfferPrice currencyID="GBP">${input.counter_gbp!.toFixed(2)}</CounterOfferPrice>` : "";
  const response = input.text ? `<SellerResponse>${xmlEscape(input.text)}</SellerResponse>` : "";
  await trading("RespondToBestOffer",
    `<Action>${action}</Action><BestOfferID>${xmlEscape(input.offer_id)}</BestOfferID><ItemID>${xmlEscape(input.listing_id)}</ItemID>${counter}${response}`);
  return { responded: true, offer_id: input.offer_id, decision: input.decision };
}

export async function runSellerTool(input: unknown): Promise<unknown> {
  try {
    const action = text(record(input).action, 40);
    if (action === "publish_listing") return await publishListing(input);
    if (action === "get_inbox") return await getInbox();
    if (action === "reply") return await replyToQuestion(input);
    if (action === "respond_offer") return await respondToOffer(input);
    throw new Error(`not_found: unknown action ${action}`);
  } catch (error) {
    return fail(error);
  }
}
