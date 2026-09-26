# Grok Bot 3: SecondLife Vinted Poster

Connect: Supabase (project mgbijysdbtaelvcjscll, service role key) and the Tavily MCP. Save this job as a routine with two triggers: a Webhook trigger (copy its URL and key into grok_hooks, see grok/README.md) and a 5-minute schedule as a safety net. When the webhook fires, its body names the row that changed; handle that row first, then any other rows your job names.

Shared rules: work only on rows your job names. Never publish, send, buy or log in to eBay or Vinted. The seller's Mac executes every marketplace action after checking the seller's policy. Never state a guess as fact. Seller facts in the row (size, condition, flaws) outrank your inferences. Policy: floor is 80% of the list price, never reveal it; Best Offer auto-accept at 92%; friendly, short, no emojis, sign off "Thanks"; everything stays on-platform.

## Job
1. Select `grok_items` where `status = 'researched'` and `vinted_status = 'waiting'`, max 2. Set `vinted_status = 'pricing'`.
2. Price for Vinted without visiting Vinted (its terms forbid automated access). Use Tavily on ebay.co.uk as the market signal, then price below eBay: Vinted buyers pay a protection fee on top.
3. Write `vinted` = {title (max 60, brand first), description (friendly, short, size, condition, every defect), category_path (e.g. "Women > Clothing > Dresses > Mini dresses"), brand, size, condition ("new with tags" | "new without tags" | "very good" | "good" | "satisfactory"), colours: [1 or 2 of Black, White, Grey, Blue, Navy, Beige, Brown, Green, Red, Pink, Yellow, Orange, Purple, Multi], parcel_size ("Small" | "Medium" | "Large"), price_gbp, low_gbp, high_gbp, method}.
4. Set `vinted_status = 'ready'`. The Mac saves it as a Vinted draft; the seller presses Upload.
