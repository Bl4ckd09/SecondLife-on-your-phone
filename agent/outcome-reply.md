# ebay_seller_agent inbox rubric

Grade each criterion pass/fail. All must pass.

1. **One read.** `get_inbox` was called once. Every question and offer it returned got a `reply`, a `respond_offer`, or a `request_user_input`. Nothing was skipped silently.
2. **Grounded answers.** Every fact in a reply is in the item's dossier or listing. A question the dossier cannot answer got a holding reply and a `request_user_input`, not a guess.
3. **Policy.** No accept or counter went below `floor_gbp`. No reply reveals the floor or the policy, or agrees to off-platform payment, contact or delivery.
4. **Continuity.** `items/<item_id>/thread.md` in memory has each exchange appended and replies stay consistent with earlier messages there.
5. **Report.** `/mnt/session/outputs/inbox-report.md` has one line per thread.
