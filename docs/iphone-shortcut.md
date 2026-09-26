# iPhone Shortcut: "Sell on eBay"

Select the photos of one item, tap Share, pick "Sell on eBay" and answer three questions. A few minutes later the item is live on eBay and a push on your phone gives the price and the link.

```
iPhone Share ─▶ Mac: worker.ts watch ─▶ ebay_item_researcher ─▶ ebay_seller_agent ─▶ eBay API publishes ─▶ push to phone
```

The Mac must be awake with the worker running, because the worker holds the eBay keys.

## Photos to take

Take 3 to 6 photos of one item: front, back, and close-ups of the brand logo and the care label. eBay buyers trust branded items more with logo and label photos. The care label also gives the agent the exact size and material.

## One-time setup on the Mac

1. Create the intake secret and the push topic:

   ```bash
   cd ~/SecondLife-eBay/agent
   echo "INTAKE_SECRET=$(openssl rand -hex 24)" >> .env
   echo "NTFY_TOPIC=secondlife-ebay-$(openssl rand -hex 6)" >> .env
   ```

2. Connect eBay once (see the README setup): `cd worker && npm install && npx tsx worker.ts login && npx tsx worker.ts setup`.

3. Find the Mac's Tailscale name with `tailscale status`. The first line shows it, for example `my-macbook`.

4. Start the worker and keep the Mac awake while it runs:

   ```bash
   caffeinate -i npx tsx worker.ts watch
   ```

## One-time setup on the iPhone

1. Install Tailscale and sign in with the same account as the Mac.
2. Install the ntfy app and subscribe to the `NTFY_TOPIC` value from step 1. Run `grep NTFY_TOPIC ~/SecondLife-eBay/agent/.env` on the Mac to see it.
3. Install the ready-made shortcut [`shortcut/Sell-on-eBay.shortcut`](shortcut/Sell-on-eBay.shortcut). Pick one route:
   - From the Mac: `open ~/SecondLife-eBay/docs/shortcut/Sell-on-eBay.shortcut`, click Add Shortcut, and let iCloud sync it to the iPhone (Settings ▸ your name ▸ iCloud ▸ Shortcuts on, on both devices).
   - AirDrop: in Finder, right-click the file ▸ Share ▸ AirDrop ▸ your iPhone, then tap Add Shortcut.
4. Answer the 2 install questions: the Mac address (its Tailscale name from `tailscale status`, or `Suns-MacBook-Pro.local` on the same Wi-Fi) and the intake secret (`grep INTAKE_SECRET ~/SecondLife-eBay/agent/.env`).
5. Open the shortcut's details and turn on Show in Share Sheet if it's off.

To change the shortcut, edit `shortcut/make_shortcut.py`, then rebuild: `python3 make_shortcut.py && shortcuts sign --mode anyone --input Sell-on-eBay.unsigned.shortcut --output Sell-on-eBay.shortcut`.

The first time the worker listens, macOS may ask whether `node` may accept incoming connections. Click Allow, or the phone can't reach the intake.

## What happens after you share

| Step | Where | State in `runs/intake/<item>/state.json` |
|---|---|---|
| Photos saved, uploaded to the Files API | Mac | `new` |
| `ebay_item_researcher` identifies the item, picks the category and prices it from eBay comps | Anthropic cloud + worker tools | `researching` |
| `ebay_seller_agent` writes the listing and calls publish | Anthropic cloud + worker tools | `listing` |
| Listing live, push sent with the link | eBay | `live` |
| The agent stopped and asked you something | your phone | `needs_you` |

An item fails after 3 tries in a row, and the push says why. To retry it, set `"status"` back to the step that failed in its `state.json` and set `"attempts"` to 0.
