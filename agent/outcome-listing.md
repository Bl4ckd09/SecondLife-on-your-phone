# ebay_poster rubric

Grade each criterion pass/fail. All must pass.

1. **Dossier-only facts.** Every fact in the listing matches `items/<item_id>/dossier.json`. Nothing is added.
2. **Competitive price.** `pricing` has numeric `price_gbp`, `low_gbp`, `high_gbp`, `fast_sale_gbp` with low ≤ fast_sale ≤ price ≤ high, `comps_used` lists kept eBay listings, and `method` explains the price. Fewer than 3 comps is stated.
3. **eBay fields.** Category came from `category_suggestions`, condition from `condition_policies`, required aspects are filled or escalated. Title is 80 characters or fewer and starts with the brand.
4. **Offers.** Best Offer lines follow `policy.md`.
5. **Outcome.** Either `publish_listing` returned a `listing_id` saved in `items/<item_id>/ebay.json`, or nothing was published and a `request_user_input` explains why (stock photos, low confidence, missing aspects).
