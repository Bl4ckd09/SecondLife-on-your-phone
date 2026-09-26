# ebay_item_researcher rubric

Grade each criterion pass/fail. All must pass. Judge substance, not bookkeeping.

1. **Identity is sourced.** `dossier.json` names brand, model or item type, and colour. Each has a photo, label, source URL or eBay listing behind it, or is filed under `uncertain`. No product code appears that is not visible in a photo or on a cited page.
2. **Evidence is honest.** No guess is stated as fact. Size and condition come from the seller's facts or a photo.
3. **eBay category.** `ebay.category_id` came from `category_suggestions`, `ebay.condition_enum` is one of that category's `condition_policies`, and every required aspect is filled or listed in `ebay.missing_required_aspects`.
4. **Competitive price.** `pricing.ebay` has numeric `price_gbp`, `low_gbp`, `high_gbp` and `fast_sale_gbp` with low ≤ fast_sale ≤ price ≤ high. `comps_used` lists the eBay listings kept, and `method` explains how comps, RRP, age and condition set the price. Fewer than 3 comps is stated, not hidden.
5. **Persistence.** `dossier.json` exists in `/mnt/session/outputs/` and at `items/<item_id>/dossier.json` in memory, and `items/<item_id>/research-notes.md` records kept and dropped comps.
