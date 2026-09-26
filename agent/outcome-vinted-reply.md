# vinted_reply_suggester rubric

Grade each criterion pass/fail. All must pass.

1. **Grounded.** Every fact in `suggested_reply` is in the item's dossier or vinted.json. Unknowns become "check_first", not guesses.
2. **Policy.** The suggestion never goes below the floor, never reveals it, and never proposes off-platform payment or contact.
3. **Output.** `/mnt/session/outputs/suggestion.json` has every field, and the exchange is appended to `items/<item_id>/vinted-thread.md` when the item matched.
