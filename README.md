# SecondLife on your phone

Take photos of a secondhand item and share them from your iPhone. SecondLife identifies the item, prices it from live ebay.co.uk listings, publishes it on eBay, saves a Vinted draft, and answers buyers within your rules.

This is a fresh build next to [SecondLife](https://github.com/Bl4ckd09/SecondLife), which stays Vinted only. eBay has official seller APIs, so here the agents publish and negotiate on their own. Vinted has no seller API and its terms forbid automation, so Vinted gets drafts and suggested replies only.

## How it works

One Shortcut, five Grok Bots, and one Mac that holds every login and enforces the rules.

![How Sell with 2ndLife works](docs/architecture.svg)

| Step | Who does it | What the Mac does |
|---|---|---|
| Identify the item, find the RRP | Bot 1 + Tavily | nothing |
| Price from ebay.co.uk listings, write the eBay listing | Bot 2 + Tavily | publishes through the eBay API |
| Price and write the Vinted listing | Bot 3 + Tavily | saves a Vinted draft in Chrome |
| Answer eBay questions and Best Offers | Bot 4 | sends the reply or offer through the eBay API |
| Suggest replies to Vinted buyers | Bot 5 | reads the Vinted email, pushes the suggestion to your phone |

The bots never hold a key. They write to Supabase, the Mac checks `policy.json`, and only then calls eBay or opens Chrome.

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
