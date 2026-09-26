# Grok path: five Grok Bots

The "Sell with 2ndLife" Shortcut puts photos in Supabase. Five Grok Bots, one per job, work on the rows. The seller's Mac executes every eBay and Vinted action after its own policy check.

```
Shortcut B ─▶ grok_items (new) ──wake──▶ 1 Researcher ─▶ status researched
                               ──wake──▶ 2 eBay Poster ─▶ ebay_status ready ─▶ Mac publishes on eBay
                               ──wake──▶ 3 Vinted Poster ─▶ vinted_status ready ─▶ Mac saves Vinted draft
Mac (every 1 min) ─▶ grok_inbox ──wake──▶ 4 eBay Buyer ─▶ answered ─▶ Mac replies / responds on eBay
Mac (every 1 min) ─▶ grok_vinted_messages ──wake──▶ 5 Vinted Reply ─▶ suggested ─▶ push to phone
```

## Set up once (about 15 minutes)

1. In the Supabase SQL editor, run `schema.sql`, `schema2.sql`, then `schema3.sql`.
2. In Cursor, create five Grok Bots. For each, paste the "Job" and the text above it from `bots/`:

   | Bot | File | Webhook name in grok_hooks |
   |---|---|---|
   | SecondLife Researcher | `bots/1-researcher.md` | `researcher` |
   | SecondLife eBay Poster | `bots/2-ebay-poster.md` | `ebay_poster` |
   | SecondLife Vinted Poster | `bots/3-vinted-poster.md` | `vinted_poster` |
   | SecondLife eBay Buyer Agent | `bots/4-ebay-buyer.md` | `ebay_buyer` |
   | SecondLife Vinted Reply Suggester | `bots/5-vinted-reply.md` | `vinted_reply` |

3. Connect Supabase (service role key) and the Tavily MCP on each bot when it asks.
4. On each bot's routine, add a Webhook trigger and a 5-minute schedule trigger.
5. Store each webhook in Supabase. In the SQL editor, run one line per bot:

   ```sql
   insert into grok_hooks (bot, url, key) values ('researcher', '<webhook url>', '<webhook key>')
     on conflict (bot) do update set url = excluded.url, key = excluded.key;
   ```

A bot without a row in `grok_hooks` still runs on its 5-minute schedule.

## Test

Share photos to "Sell with 2ndLife". The row appears in `grok_items`, Bot 1 wakes within seconds, and the Mac dashboard (http://127.0.0.1:4545) shows each status change.
