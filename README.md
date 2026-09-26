# SecondLife for eBay

Photos of a secondhand item go in. A live eBay listing at a competitive price comes out, and an agent handles the buyer questions and Best Offers after that.

This is the eBay sibling of [SecondLife](https://github.com/Bl4ckd09/SecondLife), which stays Vinted only. The idea is the same. The difference is autonomy. Vinted has no seller API, so SecondLife stops at drafts. eBay has official APIs for search, listing, messages and offers, so here the agents act on their own inside your policy.

## How it works

```
iPhone Share ▸ "Sell on eBay"
      │  photos + size, condition, flaws
      ▼
Mac worker (intake :4747) ──────────── holds the eBay keys, enforces policy.json in code
      │
      ▼
ebay_item_researcher (Claude Managed Agent, cloud)
      │  ebay_research tool: image search, active comps, category, aspects, conditions
      │  web_search (Tavily): manufacturer pages, RRP
      ▼  dossier: identity, eBay category + aspects, price range + fast-sale price
ebay_seller_agent (listing mode)
      │  ebay_seller publish_listing: photos, inventory item, offer with Best Offer lines
      ▼
LIVE on ebay.co.uk ──▶ push to your phone (ntfy)

every 10 min: ebay_seller_agent (inbox mode)
      get_inbox ▸ reply to questions ▸ accept / counter / decline Best Offers
      anything outside policy ▸ request_user_input ▸ push to your phone
```

Both agents run in Anthropic's cloud. Every eBay call runs in the worker on your Mac as a custom tool. The agent asks, the worker checks the request against `policy.json`, calls eBay, and returns the result. eBay keys never leave the Mac.

## What the agents may do

| Action | Who decides | Hard limit in the worker |
|---|---|---|
| Identify the item and price it from live eBay comps | researcher | read-only APIs |
| Publish the listing | seller agent | price between `min_price_gbp` and `max_price_gbp`, title ≤ 80, auto-decline ≥ floor |
| Answer buyer questions | seller agent | no emails, phone numbers, outside links or off-platform payment words |
| Accept or counter a Best Offer | seller agent | never below the floor (`floor_ratio` × list price) |
| Returns, cancellations, bundles, anything unclear | you | the agent escalates to your phone |

eBay itself auto-accepts offers at or above the accept line and auto-declines below the floor. The agent handles the band in between.

## Setup

You need an eBay developer keyset, an Anthropic API key, Node 22 and `python3`. Start on the eBay sandbox. Switch to production when a sandbox item has gone through end to end.

1. Keys. Put these lines in `agent/.env` (`chmod 600`):

   ```
   ANTHROPIC_API_KEY=sk-ant-...
   EBAY_ENV=sandbox
   EBAY_APP_ID=...
   EBAY_CERT_ID=...
   EBAY_DEV_ID=...
   EBAY_RUNAME=...          # developer.ebay.com ▸ User Tokens ▸ Get a Token from eBay via Your Application
   EBAY_POSTCODE=...        # where items ship from
   INTAKE_SECRET=...        # openssl rand -hex 24
   NTFY_TOPIC=...           # secondlife-ebay-<random>
   TAVILY_API_KEY=...
   VINTED_EMAIL=...
   VINTED_EMAIL_APP_PASSWORD=...
   VINTED_MAIL_MINUTES=5
   ```

   `TAVILY_API_KEY` enables researcher web search. The Vinted Gmail values are optional; use a Google app password, not the account password.

2. Worker and eBay account:

   ```bash
   cd agent/worker && npm install
   npx tsx worker.ts login     # sign in as the seller (a sandbox test user on sandbox), paste the redirect URL back
   npx tsx worker.ts setup     # business policies + inventory location, saved to agent/.ebay-setup.json
   npx tsx worker.ts check     # one comps search and one user-token refresh
   npx tsx worker.ts vinted-mail # read-only preview of matching Gmail notifications; starts no agents
   ```

3. Agents: `cd agent && ./launch.sh setup` creates the environment, the `ebay-items` memory store and both agents.

4. Phone: follow [docs/iphone-shortcut.md](docs/iphone-shortcut.md).

5. Run:

   ```bash
   cd agent/worker && caffeinate -i npx tsx worker.ts watch
   ```

It listens on port 4747, so it can run next to the Vinted worker on 4646.

With the Vinted Gmail values set, `watch` checks matching notifications every five minutes, generates reply suggestions sequentially and pushes them through ntfy. It never sends to Vinted or marks mail read.

## Policy

`agent/policy.md` is what the agent reads. `agent/policy.json` holds the numbers the worker enforces. Change both together.

## Limits

- Sold prices come from eBay's Marketplace Insights API, which needs separate approval. Until then the researcher prices from active listings and discounts them toward a fast-sale price.
- The sandbox has little listing data, so comps there are thin. Real pricing needs `EBAY_ENV=production`.
- The Mac must be awake with the worker running.

## License

[PolyForm Noncommercial 1.0.0](LICENSE.md).
