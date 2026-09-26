# item_researcher rubric

Grade each criterion pass/fail. All must pass. Judge substance, not bookkeeping.

1. **Identity is sourced.** `dossier.json` names brand, model or item type, and colour. Each has a photo, label, source URL or eBay listing behind it, or is filed under `uncertain`. No product code appears that is not visible in a photo or on a cited page.
2. **Evidence is honest.** No guess is stated as fact. Size and condition come from the seller's facts or a photo.
3. **Original product info.** `original_product.rrp_gbp` is set with a source URL, or is null with a reason in `missing_information`.
4. **Photo check.** `photos.own_photos` is set, and false whenever the photos are stock or catalogue images.
5. **Persistence.** `dossier.json` exists in `/mnt/session/outputs/` and at `items/<item_id>/dossier.json` in memory, with `items/<item_id>/research-notes.md`. No pricing or listing appears.
