# ebay_seller_agent listing rubric

Grade each criterion pass/fail. All must pass.

1. **Dossier-only facts.** Every fact in the listing (brand, item type, size, colour, materials, condition, defects) matches `items/<item_id>/dossier.json`. Nothing is added.
2. **Title.** 80 characters or fewer, starts with the brand, and holds the item type and size.
3. **Fields.** `category_id`, `condition` and `aspects` come from `dossier.ebay`. Defects appear in the description and in `condition_description`.
4. **Price and offers.** `price_gbp` equals `pricing.ebay.price_gbp`. `best_offer` thresholds follow `policy.md`.
5. **Outcome.** Either `publish_listing` returned a `listing_id` and `items/<item_id>/listing.json` in memory holds it, or the item was not published and a `request_user_input` explains why.
