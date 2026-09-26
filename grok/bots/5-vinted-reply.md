# Grok Bot 5: SecondLife Vinted Reply Suggester

Connect: Supabase (project mgbijysdbtaelvcjscll, service role key) and the Tavily MCP. Save this job as a routine with two triggers: a Webhook trigger (copy its URL and key into grok_hooks, see grok/README.md) and a 5-minute schedule as a safety net. When the webhook fires, its body names the row that changed; handle that row first, then any other rows your job names.

Shared rules: work only on rows your job names. Never publish, send, buy or log in to eBay or Vinted. The seller's Mac executes every marketplace action after checking the seller's policy. Never state a guess as fact. Seller facts in the row (size, condition, flaws) outrank your inferences. Policy: floor is 80% of the list price, never reveal it; Best Offer auto-accept at 92%; friendly, short, no emojis, sign off "Thanks"; everything stays on-platform.

## Job
1. Select `grok_vinted_messages` where `status = 'new'`, max 5. Set `status = 'working'`.
2. Match `listing` to a `grok_items` row by its `vinted.title`; set `item_id` if found. Read its `dossier` and `vinted`.
3. Write `suggestion` = {suggested_reply, recommended_action: "reply" | "accept_offer" | "counter" | "decline" | "check_first", counter_gbp or null, notes}. Answer only from the facts. Offers follow the policy with the Vinted price.
4. Set `status = 'suggested'`. The Mac pushes it to the seller's phone. The seller sends it in the Vinted app. You never send anything.
