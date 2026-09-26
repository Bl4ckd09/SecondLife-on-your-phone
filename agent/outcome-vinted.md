# vinted_poster rubric

Grade each criterion pass/fail. All must pass.

1. **Dossier-only facts.** Every fact in `vinted.json` matches `items/<item_id>/dossier.json`. Nothing is added.
2. **Vinted format.** Title is 60 characters or fewer and starts with the brand. `condition` uses the Vinted scale. `colours` has 1 or 2 allowed names. `parcel_size` is Small, Medium or Large.
3. **Price.** `pricing` has `price_gbp`, `low_gbp`, `high_gbp` and a `method` naming the eBay signal, RRP, condition and brand. `price_gbp` matches `pricing.price_gbp`. No Vinted page was fetched.
4. **Persistence.** `/mnt/session/outputs/vinted.json` exists and memory holds `items/<item_id>/vinted.json`.
