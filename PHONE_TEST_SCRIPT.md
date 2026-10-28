> **Status:** real. **Verified:** 2026-10-27. **Owns:** nothing (a checklist for Pierre's phone).

# Phone test script: what is built but not yet seen on real data

Do these in order, in a NEW claude.ai chat with The Office connected ("Read and create"). Use small amounts and a test business. After each step the pass is what `list_expenses`, `list_payments` or `list_held_actions` shows, so Claude can check itself. Tell Claude what happened if anything differs.

1. **Held list.** Say: "List my held actions." Pass: the earlier confirmed items (the R30 glue expense, quote 30) show as confirmed, with no raw text.
2. **Edit, then revert.** Say: "Record an expense of R25 for test tape, category materials, and confirm it." Then: "Change that expense to R35." Then: "List expenses from today." Pass: one R25-then-R35 expense, marked as created through the connection. Now in the app, open Assistants, then the page of what assistants created, and revert the change. Say: "List expenses from today." Pass: R25 again.
3. **Undo.** Say: "Record a payment of R10 from a test customer and confirm it." In the app, undo it from the same page. Say: "List payments from today." Pass: the payment is gone. Undo the R25 expense too; it should leave the expense list.
4. **Reject.** Say: "Record an expense of R12 for test rope. Do not confirm it, reject it." Say: "List held actions that are rejected." Pass: it shows as rejected and `list_expenses` has no R12.
5. **Supplier document, supplier named.** Say: "Get an upload link", send a supplier invoice with the supplier's name typed in the box. Pass: it shows as a pending held supplier invoice; Claude cannot confirm it, so confirm it in the app.
6. **New app screens.** Install the next app build, then look at the refusal screen, the Activity room, the Analysis sheet and a customer's phone and email.

## Results, last run 2026-10-27 (real data, Zululand business)
| Step | Result |
|---|---|
| 1. Held list | Pass |
| 2. Edit and revert | Pass: expense #13 R25 to R35 and back. The revert row (CHANGED section) is only in builds after `94b7204`; Pierre's installed APK (`d71f1f6`) lacks it, so it was tapped in the web preview |
| 3. Undo | Pass: a payment and an expense removed |
| 4. Reject | Pass: held #183 rejected, no R12 expense |
| 5. Supplier upload | Pass with a camera photo attached with +: a delivery note against purchase order #15 became GRN #10 plus held #184 (stock add) and #185 (supplier invoice); an invoice with no open order was recognised and nothing was recorded |
| 6. New screens | Seen in the web preview only; the installed APK is older and Codemagic builds were stuck in Queued |

Also run: a customer detail proposed, confirmed from the chat and undone in the app (#187, phone). Not yet run: a stock add confirmed from the chat and then undone.

