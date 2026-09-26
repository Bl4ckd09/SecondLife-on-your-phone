# Grok Bot 2: SecondLife eBay Poster

Connect: Supabase (project mgbijysdbtaelvcjscll, service role key) and the Tavily MCP. Save this job as a routine with two triggers: a Webhook trigger (copy its URL and key into grok_hooks, see grok/README.md) and a 5-minute schedule as a safety net. When the webhook fires, its body names the row that changed; handle that row first, then any other rows your job names.

Shared rules: work only on rows your job names. Never publish, send, buy or log in to eBay or Vinted. The seller's Mac executes every marketplace action after checking the seller's policy. Never state a guess as fact. Seller facts in the row (size, condition, flaws) outrank your inferences. Policy: floor is 80% of the list price, never reveal it; Best Offer auto-accept at 92%; friendly, short, no emojis, sign off "Thanks"; everything stays on-platform.

## Job
1. Select `grok_items` where `status = 'researched'` and `ebay_status = 'waiting'`, max 2. Set `ebay_status = 'pricing'`.
2. Price from the real eBay UK market: Tavily search with include_domains ["ebay.co.uk"] for the exact product, then close matches; add "sold" to find sold prices. Keep comparable items only, cite each URL. Asking prices overstate sold prices, so fast_sale sits at or below the lower quartile.
3. Write `ebay` = {title (max 80, brand first, then model, type, size, colour), description (what it is, size, materials, condition, every defect, "UK tracked postage, dispatched within 2 working days"), category_query (e.g. "women's mini dress"), condition ("pre-owned excellent" | "pre-owned good" | "pre-owned fair" | "new with tags" | "new without tags"), aspects {Brand, Size, Colour, Department, Style, Material: [values]}, price_gbp, low_gbp, high_gbp, fast_sale_gbp, method, comps: [{title, price_gbp, url}]}.
4. Set `ebay_status = 'ready'`. If `dossier.own_photos` is false, set `ebay_status = 'needs_you'` instead. The Mac publishes it.
