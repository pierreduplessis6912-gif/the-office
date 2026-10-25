> **Status:** real. **Verified:** not yet. **Owns:** none.

# DECISIONS: bug-archive

Part of [DECISIONS.md](../../DECISIONS.md), split from it on 2026-10-24 without changing a word (the original is `git show 95bf743:DECISIONS.md`). Sections keep their original order.

## Complete bug archive (full, unabridged history — see STATUS.md's Failure Shapes for the distilled patterns)

**2026-07-08:**
1. **Reconciliation collision.** First-token-only name matching
   silently merged two different customers who shared a first name
   ("John Wilkins" matched an existing "John Titlestadt"). Fixed:
   requires both first AND last name to match when a full name is
   given; falls back to loose first-token matching only when genuinely
   just one name was spoken.
2. **Unguarded structured-fact writes.** `applyStructuredFact` fired
   immediately via `ctx.waitUntil`, independent of `guard()` — a
   misreconciled customer (bug #1, before the fix landed) had their
   real address silently overwritten before anyone ever saw a
   confirmation prompt to reject. Fixed: structured facts now hold in
   `pending_actions` (type `customer_fact`) exactly like money.
3. Reranker/embedding thresholds were never reliable absolute numbers
   — both replaced with relative-ranking approaches, discovered via
   real test data, not assumption.
4. Silent background failures (`ctx.waitUntil` with no `try/catch`)
   recurred multiple times — always log to `memory_errors` now.
5. Lookups (questions) must never be stored as memory facts — two
   independent defenses: intent classification AND a deterministic
   `looksLikeAQuestion()` text-shape check, since classification alone
   has been observed to misfire.
6. Bare pronouns ("her", "him") were being accepted as customer names,
   creating garbage records — a `NOT_A_NAME` denylist plus a minimum
   length check now rejects them before any customer gets created.

**2026-07-09:**
7. **Recency-vs-frequency pronoun resolution.** `rewriteQuery` was
   resolving "her" to whichever person was mentioned *more often* in
   recent history, not most recently — even after an explicit prompt
   rule stating recency should win. Fixed by enabling `thinking: true`
   for this specific call, proven necessary via a real side-by-side
   comparison (thinking off: wrong customer; thinking on: correct,
   with a real reasoning trace showing it correctly applying the rule).
8. **Single-customer balance lookups never touched real financial
   data.** "What's Sarah's balance" only searched narrative KV notes
   — real confirmed payments and invoices were invisible to it, so a
   customer who had genuinely paid still came back "I don't have that
   on file." Fixed: `getCustomerFinancialSummary` now always runs
   alongside narrative notes for any customer-scoped lookup, honest
   about the case where payments exist with no invoice to balance
   against (a real "credit," not a fabricated debt).
9. **Silent, catastrophic unit error in work observations.** A real
   message ("Theatre 2 is 8 by 6") had its dimensions written straight
   into `width_mm`/`length_mm` fields with no unit conversion,
   producing `area_sqm: 0.000048` instead of the real 48 m² — off by a
   factor of a million, silently, with total confidence. Fixed: the
   model now reports the raw number plus which unit it recognizes was
   meant (mm or m, from magnitude and context); the actual
   multiplication always happens afterward, in code.
10. **Tasks had no link to which component they belonged to.** "Theatre
    2 needs moisture testing" and "Theatre 3 needs skirting removed
    first" both landed as flat, unlabeled job-level tasks. Fixed:
    `scope_tasks.component_id`, resolved in code from an optional
    `component_name` the model reports per task.

**2026-07-10:**
11. **Subject-attribution: extraction picked an incidentally-mentioned
    name over the real subject of the message.** "ProSupply was late
    delivering the tiles for Jenny's job back in March" got filed
    under Jenny (the job mentioned as context) instead of ProSupply
    (who the message was actually about — the late delivery). Found
    live while seeding a real multi-turn retrieval test, not
    synthetically. Fixed: the extraction prompt now explicitly asks
    "who or what is this sentence fundamentally reporting on," not
    just which names appear in it — with a real example baked in.
    Live data this had already polluted (a stray note filed onto
    Jenny Hawke's real customer file) was corrected by hand afterward
    via the two debug routes added for exactly this.
12. **`character_name` was defined too narrowly — personal relations
    only, no way to hold a supplier.** The same bug above also
    revealed that a supplier ("ProSupply") had nowhere safe to live:
    forcing it into `customers` would have made it silently
    quotable/invoiceable, the exact class of risk `characters` exists
    to prevent for personal relations. Fixed by broadening the real
    invariant: `character_name` now covers anyone NOT billed by the
    tradesperson — personal or business — not just personal relations.
    `characters.relationship` already stored a free string; no schema
    change needed, only the extraction prompt's definition.
13. **A named staff contact at a supplier fragmented off its own
    entity.** "Called ProSupply... spoke to Sarah in dispatch" filed
    the note under a brand-new standalone character "Sarah",
    disconnected from ProSupply — the fact that actually explained why
    Peter stopped buying from them became unreachable by asking about
    ProSupply. Fixed with the same subject-attribution discipline as
    bug #11: a person named only as a company's staff/contact is a
    detail of that relationship, not a separate entity.
14. **`rewriteQuery` reliably looped under `thinking: true` on
    fact-summary references, no matter how the prompt was tuned.**
    Real multi-turn testing (why don't we buy from ProSupply anymore →
    who did we deal with in those instances) found the model
    redrafting the same near-identical rewritten sentence five-plus
    times, hitting the token ceiling with empty content — confirmed via
    a dedicated raw-introspection debug route showing the actual
    reasoning trace and `finish_reason: length`, not guessed at. Five
    separate fixes attempted first (raising `max_tokens` 600→1200→2500,
    fixing a self-conflicting worked example, explicit decisiveness/
    conciseness rules, a classify-then-route split between `thinking`
    modes) — all failed to stop the loop, because the real cause was
    open-ended prose *generation* having no natural stopping point
    under `thinking: true`, not any specific wording. See the
    Extraction schema section above for the actual fix: the whole
    approach was replaced with closed-form entity extraction
    (`resolveFollowUpEntity`), not patched further.
15. **The replacement's first version anchored on the wrong entity.**
    `resolveFollowUpEntity` initially picked any name mentioned in the
    office's own reply, not necessarily the actual standing topic —
    it resolved "who did we deal with" to "Sarah" (a supporting detail
    inside ProSupply's notes) instead of "ProSupply" itself, and that
    wrong name then collided with an unrelated real customer
    coincidentally also named Sarah. Fixed by anchoring explicitly on
    what Peter's own question was originally about, treating other
    names in a reply as supporting detail unless the new message
    specifically asks about one of them.

**2026-07-11, found live via the static preview UI, not curl testing:**
16. **A reminder's raw transcript leaked a personal errand into a
    customer's own file.** "Heading to jenny's job now, remind me to
    get dog food after" correctly isolated `personal_note`, but the
    raw transcript — dog food and all — was *also* stored verbatim as
    a customer note under Jenny, since storage only skipped that
    fallback when there was no customer at all. Same subject-
    attribution principle as bug #11, just missed for this intent.
    Fixed by excluding "reminder" (and later "task_complete") from
    ever writing to a customer/character's own note store.
17. **Business-scope follow-ups pulled in unrelated fact sets.** "How
    many quotations are pending?" → "names and amounts" surfaced
    invoice-balance facts too, because business-scope lookups always
    fetched both outstanding-invoice and quotation facts regardless of
    which one the conversation was actually about. Fixed with
    `classifyBusinessTopic`, the business-scope sibling of
    `resolveFollowUpEntity` — same standing-topic anchoring, one level
    up from named entities.
18. **A purely-personal reminder involving a character created no
    task at all, silently.** "Remind me to phone my mother" correctly
    classified as `reminder` with `character_name: "mother"`, but left
    `personal_note: null` — the model treated the whole message as
    being about that character rather than a mixed split, since there
    was no separate customer to split away from. Task creation used to
    depend on `personal_note` being set, so no task was created, while
    the response still said "Got it." Fixed by decoupling: a reminder
    always creates a task now, falling back to the full transcript
    when there was nothing to split.
19. **Bare pronoun-only task completions ("did that", "called them")
    misclassified as `note` instead of `task_complete`, twice in a
    row.** Root cause: `extractIntent` classifies before it ever knows
    what open tasks exist, so it had no grounding that a vague
    completion was even plausible. Fixed by broadening the
    `task_complete` rule and examples to explicitly include pronoun-
    only phrasing — the real matching precision still lives entirely
    downstream, in code, against the real open-task list.
20. **A real architectural correction, not just a bug: task
    completion matching was originally implemented as an AI call**
    (`resolveTaskCompletion` handed Kimi the list of open tasks and
    asked it to judge which one matched). Direct testing surfaced a
    real, repeatable failure mode this design invites: real
    ambiguity (two genuinely similar open "call" tasks) needing to be
    asked about rather than guessed. Working through this live
    produced the session's biggest standing principle — see "The
    Execution Ladder" below — and the function was rebuilt as pure
    deterministic word-token matching, zero AI calls. The rebuild
    itself then surfaced a second, narrower bug: naive full-string
    substring matching missed "called" against "call" entirely,
    falling back to presenting *every* open task as a candidate,
    including a completely unrelated one ("pick up the kids" showing
    up for "called them"). Fixed with light deterministic stemming and
    token-overlap matching instead of substring containment — still a
    literal index, not AI judgment, just a correct one. Verified
    directly in Node before ever redeploying.
21. **The smoke-test suite itself became unreliable at 17 cases.**
    Running all cases concurrently via `Promise.all` started tripping
    Workers AI's own capacity limit ("3040: Capacity temporarily
    exceeded"), which never happened at 11–14 cases. A regression
    suite that fails under its own concurrent load isn't trustworthy;
    fixed by running cases sequentially instead.

**2026-07-11, execution register:**
22. **The register check was gated behind `history.length > 0`,**
    inherited unchanged from the old AI-only fallback it replaced.
    The register reads real, persisted D1 state — it needs no history
    at all — but a live test that deliberately sent no history skipped
    it entirely and fell through to "I don't have that on file." Fixed
    by making the register check unconditional whenever nothing was
    directly named; only the genuine AI-based fallback stays gated
    behind having real history text to scan.
23. **`getCurrentSelection` was hardcoded pairwise comparison of
    exactly two type names, not actually a generic primitive** — it
    only looked like one because the schema underneath it already
    was. Caught before a third type could multiply the pattern:
    rebuilt as a single query with no type names in it at all,
    ordered by `updated_at`. Adding a third, fourth, or tenth selection
    type now means only inserting rows under a new key.
24. **Phantom customer/character creation on lookup**, found via
    external code review and confirmed against the actual code:
    `reconcileCustomer`/`reconcileCharacter` create a row on no-match
    and were called unconditionally for every intent, including
    `lookup` — so asking about someone who doesn't exist silently
    created them, then correctly said "I don't have anything on
    file." A real violation of Principle 1 (a lookup should be pure
    resolution, never a write), fixed by routing lookup intent
    through the already-existing read-only `findExistingEntityByName`
    instead.

**2026-07-11, real scheduling ("what's up today"):**
25. **The execution register silently overrode a genuinely self-
    scoped question.** "What's up for today?" was correctly classified
    `query_scope: "personal"` by the model — no entity involved at
    all — but the register still fired (intent=lookup, no name given)
    and silently rewrote it to a customer lookup about whichever
    customer was most recently touched, answering "New customer
    Sipho, measured the office..." instead of the actual schedule.
    Fixed by excluding `personal`-scoped lookups from register/AI
    fallback resolution entirely — that classification is a strong,
    reliable signal nothing entity-specific is being asked about.
    Deliberately kept `business`-scoped lookups eligible for the
    fallback: the already-proven ProSupply case genuinely needs it to
    correct an uncertain business-wide guess into the right entity, so
    the fix couldn't be "block the register for anything non-
    customer" — the two cases needed different treatment.
26. **`answerFromMemory` silently dropped facts under its own "be
    brief, one sentence" instruction** whenever a question genuinely
    had multiple distinct relevant answers. "What's up today" combining
    one scheduled job and five open tasks collapsed down to mentioning
    only the job — not wrong, just incomplete, and silently so. The
    same failure family as the dog-food bug from earlier this session,
    the opposite symptom: that one crammed in too much irrelevant
    content into one sentence, this one dropped too much relevant
    content trying to stay in one — both from asking a single sentence
    to do a list's job. Fixed by requiring coverage of every relevant
    fact; a single-fact answer still naturally comes out as one
    sentence, a multi-fact one becomes a short list instead of a
    silent omission.

**2026-07-11, ember bar and a regression it exposed:**
27. **Task descriptions stored the raw "remind me to..." phrasing
    verbatim**, making completion messages read oddly ("Marked done:
    remind me to get dog food" instead of "Marked done: get dog
    food"). Fixed with a small, deterministic prefix-stripper
    (`cleanTaskDescription`), verified directly in Node before
    deploying. Historical tasks created before the fix keep the old
    phrasing — same honest asymmetry as the captures FK backfill, not
    silently rewritten.
28. **A real regression in `answerFromMemory`, caught the very next
    time "what's up today" was tested for real.** As life events
    genuinely accumulated across a full day of real testing, the
    personal-scope fact list grew long enough that the model started
    echoing raw life-event facts back nearly verbatim — dropping the
    actual schedule/task facts entirely, which were appended later in
    the array and never reached. Bug #26's fix (cover every relevant
    fact) was correct but left "relevant" ambiguous under a long,
    noisy fact list. Fixed two ways: facts reordered so the most
    directly relevant ones (schedule, completed-today) come first,
    life events last as supplementary context; and the prompt
    tightened to make relevance-filtering an explicit, separate step
    from coverage — "decide what answers this question first, then
    cover all of those, don't just repeat back everything given."

**2026-07-12, real expense capture (first crash found via a live 1101
error, not curl output):**
29. **A real crash on the very first live expense test** — Cloudflare
    error 1101, an unhandled exception. Root cause: the generic
    `pendingActionId` confirmation-message branch (shared by payment,
    invoice, quotation, price_scope) used a `customer!.name` non-null
    assertion that had silently held for every intent built so far,
    because every one of them was genuinely keyed to a customer.
    `expense` was the first guard()'d intent keyed to `character` (a
    supplier) instead — `customer` was correctly `null`, and the
    assertion, which TypeScript accepted at compile time, threw at
    runtime on every real message. Fixed with a dedicated `expense`
    branch, same pattern as `task_complete` and `convert_quote`
    getting their own branches before it. Worth remembering the shape
    of this one specifically: a non-null assertion is only as safe as
    every future caller sharing the same assumption — the moment a
    genuinely different shape (character instead of customer) reuses
    a "generic" branch, the assertion becomes the bug.
30. **A more serious variant of the same theme, found live 2026-07-12
    while testing expense categorization:** the guard() condition for
    `expense` required a named supplier (`character`) to exist before
    the expense would even be held for confirmation at all. "Filled up
    the bakkie with diesel for R650" — a completely real, common
    expense with no clear supplier character — silently vanished with
    no pending action, no record, and no error. `recordExpense`
    already correctly supported a null `characterId`; the guard
    condition itself was the bug, requiring something that was never
    actually necessary. This is the exact silent-loss failure mode the
    receptacle exists to prevent, just one layer past where the
    receptacle can catch it — the raw capture was logged correctly,
    but the *business record* it should have produced never
    materialized. Fixed to require only a real amount, same pattern as
    `invoice`. Verified live: `characterId: null` now correctly
    recorded rather than silently dropped, categorization
    (`classifyExpenseCategory`, 2026-07-12 — real, closed-set AI
    classification into materials/fuel/tools/subcontractor/other, same
    shape as `classifyBusinessTopic`, legitimate per Principle 2 since
    a wrong category is low-stakes and easily corrected) confirmed
    working correctly alongside the fix in the same test.
31. **The job-profitability caveat was reliably stripped out during
    synthesis, twice in a row, live 2026-07-12.** `getJobProfitability`
    used to bake its "only explicitly-linked expenses count" caveat
    into one combined fact string handed to `answerFromMemory` — and
    the model's own relevance-filtering (correctly protective in every
    prior case) treated the caveat as extraneous and dropped it both
    times a real profitability question was asked. A caveat qualifying
    the very number being reported isn't optional context to weigh —
    fixed by splitting the return into `{fact, caveat}` and appending
    the caveat deterministically in code after synthesis, never a fact
    the model could discard. Same fix pattern as the aged-debtors
    capability hint (bug-adjacent feature, not numbered separately).

**2026-07-12, team support ("how's Sipho doing") — a real, three-layer
debugging chain, each bug only found because the previous one got
fixed and testing kept going:**
32. **A real name collision silently defeated character resolution.**
    "Sipho" existed as both a customer (id 12, an unrelated much
    earlier test) and a character (id 7, today's real installer). A
    lookup for `character_name` used `findExistingEntityByName` — a
    function that checks customers first, found the wrong-type match,
    correctly rejected it, and had nothing left to fall back to,
    leaving `character` silently unset even though the right character
    genuinely existed. The register/AI-fallback then kicked in and
    answered about a completely unrelated customer. Root cause: that
    function is genuinely correct for its own real use (the register's
    ambiguous-reference fallback, where the type truly isn't known in
    advance) — the bug was using it in the lookup branch, where
    extraction had already told us which table a name came from.
    Fixed with `findExistingCustomerByName`/`findExistingCharacterByName`
    — type-specific, read-only lookups for when the type is already
    known. Verified via a direct diagnostic route
    (`/debug/find-character`) proving the lookup itself was correct in
    isolation before chasing the bug further downstream.
33. **The deeper bug, only visible once #32 was fixed: `answerFromMemory`
    judged real, correct, directly relevant facts as not answering the
    question at all**, triggering its own "say you don't have that on
    file" instruction. Diagnostics proved every layer upstream was
    correct — character resolution, job-installer linking, fact
    assembly all returned exactly the right data. The actual bug was
    in how the model read "how's Sipho doing?" — as a general wellbeing
    check, not what it meant in context. **The first fix was itself a
    mistake, caught and corrected live**: forcing "how's X doing" to
    always mean work status was still a guess, just a different one —
    it would have confidently answered wrong the moment someone
    genuinely meant wellbeing. Corrected to Principle 24: never guess
    which interpretation of an ambiguous question was meant; share
    real, known facts about the person anyway, since withholding
    known information on a technicality of wording is worse than
    answering something slightly off the literal question. Verified
    live: "how's Sipho doing?" now correctly surfaces his real job
    assignment.

**2026-07-13, real multi-intent processing — the architectural
response to a real problem named directly: a beta user's first
message will be exactly as wide as a real conversation, and if
compound messages can't survive contact with the system, there's no
point shipping.** `processTranscript` split into `processOneExtraction`
(the reusable core — internal logic UNCHANGED from the proven single-
intent version) and a thin outer wrapper that logs the raw capture
once, splits a message into genuinely separate topics via
`extractMultipleIntents`, and runs each one through the same
guard()/record logic that already existed per intent. Deliberately
built the safe way: `extractMultipleIntents` reuses `extractIntent`
unchanged on each identified segment rather than duplicating its
large, carefully-tuned prompt. `ProcessResult` gained `pendingActionIds`
(a real array — a compound message can hold more than one guard()d
item) alongside `pendingActionId` for backward compatibility. Seeded
immediately with a real, compound message (an invoice, a job
observation, two reminders) and found three real bugs in the process,
each one only visible because the previous one got fixed:
34. **A work-observation segment naming only an installer, no separate
    customer, had the installer's name forced into `customer_name`**
    since it was the only name available — creating a job scope linked
    to the wrong entity. Root cause was in `extractIntent`'s own
    customer_name/character_name distinction, not the split — it would
    have misfired the same way even in a single, non-split message
    with this exact phrasing. Fixed with an explicit rule: who's DOING
    the work is never customer_name, even when no other name exists to
    fall back to.
35. **Fixing #34 exposed a real, direct consequence**: `recordWorkObservation`
    required a non-null `customerId`, so a correctly-resolved "no
    customer named yet" would have silently dropped the entire
    measurement. Fixed to record with a null customer link rather than
    lose it — Principle 22 applied directly. Also caught, before
    shipping: the message-building code used a `customer!.name` non-
    null assertion that would have thrown the moment a work
    observation genuinely had no customer — same pattern as two
    earlier crashes this session, caught this time before it reached
    production.
36. **The split itself over-triggered on the word "and" as a topic
    boundary**, breaking one continuous work observation ("Sipho is
    measuring the hospital and theatre one is three by two") into two
    incomplete fragments — a room's dimensions separated from the job
    observation they belong to. Fixed with an explicit rule ("and"
    does not by itself mean a new topic) rather than relying on one
    example to convey it implicitly, plus a directly matching example.
37. **A real, confirmed live crash (error 1101)**, traced precisely
    rather than guessed at: fixing #35 in code wasn't enough, because
    `job_scopes.customer_id` had a real `NOT NULL` constraint in the
    live schema that a TypeScript type change alone can't touch.
    Confirmed via direct schema introspection (`PRAGMA table_info`,
    added as a real, reusable diagnostic route) rather than
    reconstructing the schema from memory of the code that reads it.
    Fixed with a careful, atomic table-recreation migration (SQLite
    can't relax a NOT NULL constraint via a simple ALTER) — every real
    column preserved exactly, IDs preserved exactly since
    `job_scopes.id` is referenced by `scope_components`/`scope_tasks`.
    **Verified with a real before/after row-by-row comparison**, not
    just "it deployed successfully" — 7 job scopes before, 7 after,
    identical IDs, identical data, zero loss.

All four bugs fixed, verified live together in the original compound
message that surfaced them: a real invoice correctly guard()'d, a
real job scope correctly linked to the right entity with no crash,
and the two reminder-shaped segments (already independently verified
correct — a real task, a real character note) all recorded from one
message, each in its own correct home.
38. **One more found during the migration's own verification, not the
    feature itself**: `/debug/job-scopes` used an `INNER JOIN` against
    customers — which silently excludes any row with a `NULL`
    `customer_id` from the view entirely, real data sitting untouched
    in the table but invisible to the debug route meant to show it.
    Not a data-loss bug, a visibility bug, but a real one now that a
    job scope can genuinely have no customer yet. Fixed to `LEFT
    JOIN`. Caught precisely because verification didn't stop at "the
    migration ran successfully" — it went looking for the specific
    row it expected to see and found it missing, which is what
    actually surfaced this.

**The whole arc, five real bugs deep, closes with one thing worth
naming plainly: every single one was found because testing kept going
past the point where things "looked fixed."** The Sipho fix revealed
the over-split; the over-split fix and the nullable-customer fix
together revealed the live crash; fixing the crash and verifying it
properly revealed the debug view's own blind spot. None of these
would have surfaced from a single pass of "does this work now?" —
only from checking the actual, specific thing each fix was supposed
to produce, every time.

**2026-07-17:**
39. **A parallel storage channel bypassed a gate applied to its
    primary channel.** Found while directly, live-testing the freshly-
    extended customer-scope permission gate with three real sessions —
    Owner, Installer, Accountant, each asking "what does Jenny owe?"
    Installer correctly received the honest refusal for the structured
    financial summary ("Jenny's financial balance exists but is
    restricted for your role") — then, in the very same response,
    received the identical fact anyway: "Jenny paid R500," verbatim,
    from a completely separate code path. `getCustomerFinancialSummary`
    was correctly gated behind `can_know_debtors`; the raw-transcript
    customer-note fallback (`appendCustomerNote`), which fires for any
    non-question, non-personal-errand message about a customer, was
    gated by nothing at all — it had been silently duplicating every
    payment, invoice, quotation, and priced job into an ungated note
    since the fallback was first built, entirely independent of the
    structured tables that were later given real permission gates.
    Fixed by excluding any intent with its own real structured storage
    (payment, expense, invoice, quotation, price_scope,
    work_observation) from the raw-note fallback — it now only fires
    for genuinely narrative facts with no other structured home,
    exactly its original purpose. Verified with a brand-new customer
    (no pre-existing note to leak from): Installer received only the
    honest restriction, nothing else. Real, decisive proof, and the
    same discipline as always — the leak was found by testing the real
    thing, not assumed fixed once the primary gate was in place.

40. **A pronoun-continuation clause wrongly treated as its own topic.**
    Found while testing the newly-built line-item discount feature —
    "Quote for Jenny - supply and fit vinyl for R8000, give her 10
    percent off that" produced a real quotation for the full R8000,
    the discount silently missing. Checking the actual stored
    `source_transcript` on the pending action revealed why: the
    discount clause was never part of it at all. `splitIntoTopics`
    had separated "give her 10 percent off that" into its own segment,
    which classified as a generic "note" and vanished with no
    connection to the quotation it was meant to modify — the pending
    action's own stored payload was the direct evidence, not a guess.
    The same underlying shape as bug #36 (over-splitting on "and"),
    but a different linguistic trigger: a pronoun ("that") referring
    directly back to something just stated is exactly as strong a
    continuation signal as "and," and the splitter had no rule
    covering it. Fixed with an explicit rule and a real worked example
    in the splitting prompt. Verified twice — `/debug/split-topics`
    directly confirmed the clause now stays attached, and the full
    end-to-end flow produced a correct R7,200 quotation, itself
    verified against the raw stored `discount_percent` and
    `line_total` on the pending action, not just the summary message.
    The discount feature itself was correct throughout; it simply
    never received the information it needed until segmentation was
    fixed first.

41. **A third-party dependency type-checked and bundled cleanly, then
    failed at actual runtime.** Building PDF text extraction: `unpdf`
    installed cleanly, its real API was verified directly (installed
    locally, inspected the actual type definitions rather than
    guessed), and `tsc` found zero errors. Deployed successfully.
    Uploading a real PDF failed anyway — "Serverless PDF.js bundle
    could not be resolved: TypeError: Object.defineProperty called on
    non-object" — a failure specific to `unpdf`'s own internal dynamic
    resolution of which PDF.js build to use, only reachable at actual
    runtime inside the real Workers sandbox, invisible to local
    type-checking or bundling. Fixed by switching to `pdfjs-serverless`
    directly — the lower-level, zero-dependency package `unpdf` itself
    wraps — avoiding whatever dynamic resolution step was failing.
    Verified live: real, correct text extracted from a real PDF
    (Office's own generated quotation, round-tripped through upload
    and extraction). The same underlying principle as bug 37/38
    (verify against live reality, don't assume from what compiles) —
    applied here to a third-party dependency's actual runtime behavior
    rather than the project's own schema, a genuinely broader instance
    of the same failure shape.

**2026-07-20 — the first real, live provisioning run, Zululand
Flooring's own genuinely isolated instance:**

42. **A resource-creation command's own output format didn't match
    what the parsing regex was written against.** The KV namespace
    creation step's ID-extraction regex was anchored to the older,
    TOML-style output (`id = "..."`); the actual wrangler version in
    use (4.86.0) outputs JSON (`"id": "..."`) by default. Found live —
    the KV namespace was genuinely created successfully, but the
    workflow failed anyway because it couldn't read back the ID it
    needed for the next step. Fixed the same robust way D1's own
    parsing already worked: extract the ID by its real shape (32 hex
    characters) rather than depending on any particular surrounding
    syntax, so it doesn't matter which format a given wrangler version
    defaults to.
43. **`wrangler deploy` needs a real permission no documentation
    checked surfaced: User → User Details → Read.** Every account- and
    zone-level permission already confirmed correct (D1, R2, KV,
    Vectorize, Workers Scripts, DNS) still wasn't enough — deploy
    itself needs to verify who's using the token, a genuinely separate
    permission category (user-level, not account or zone-scoped) from
    everything already researched. Found only by an actual failed
    deploy; the error message itself named the missing permission
    precisely.
44. **`wrangler kv namespace list --json` failed outright: "Unknown
    argument: json."** The same `--json` flag confirmed working for
    `wrangler d1 list` (and used successfully elsewhere in this same
    workflow) isn't supported by every wrangler subcommand — a real,
    undocumented inconsistency across the CLI, not a single bug so
    much as evidence the CLI's own flag support can't be assumed
    uniform. Fixed by moving both the D1 and KV existence-checks off
    wrangler's CLI list output entirely, onto the raw Cloudflare REST
    API directly — the same, more reliable pattern already proven
    working elsewhere in this exact workflow (the zone lookup, the DNS
    record check), now applied consistently rather than mixed with a
    CLI dependency that had just proven unreliable.
45. **Binding a deployed Worker to its actual URL route needs its own,
    separate zone-level permission: Zone → Workers Routes → Edit.**
    The script itself deployed successfully — real, visible upload
    confirmation, correct bindings shown — and only then failed,
    specifically on the request to attach the route. A different
    permission from DNS:Edit, even though both are scoped to the same
    zone; confirmed against Cloudflare's own official Workers
    documentation, not guessed, once the precise, real error pointed
    at what was missing.

**All four found only by actually running the pipeline, never by
research alone** — the same discipline this whole bug archive has run
on from its very first entry, now proven true for infrastructure, not
just conversational extraction. Verified fully working, end to end,
immediately after: `/health`, `/debug/smoke-test`, and the real,
correctly-seeded Owner membership all confirmed independently on the
new, genuinely separate instance.

**2026-07-21 — found while testing the very first item on a routine
follow-up list, the most serious bug this project has found:**

46. **The model fabricated a real quotation from a message that never
    stated a price at all.** "Measured Thabo lounge at twenty five
    square meters, fitting laminate" — no rand figure, no rate, no
    price language anywhere — produced a real, held-for-confirmation
    quotation for R625 (25 sqm × a fabricated R25/sqm rate). Traced to
    `extractScopePricing`'s own system prompt, which opened with "a
    tradesperson is stating prices to apply to a job that was already
    measured" — a presumption, baked into the very first sentence,
    that a price exists to be found. The prompt also echoes each
    component's real, already-known area back to the model as context
    (`"Thabo lounge (25 sqm)"`) — and on this message, the model
    mistook that already-given area for a stated rate, since the same
    number ("twenty five") appeared in the transcript too. Every other
    failure shape in this archive is about a real, stated fact being
    dropped, misattributed, or misrouted — this is the first found in
    the opposite direction: a fact that was never stated at all,
    invented instead. Given this touches real money and a real,
    confirmable action, it's the most serious bug found this project,
    not just a new pattern.
    - **Fixed in two layers, deliberately not relying on the prompt
      alone.** The primary, load-bearing fix: a real, deterministic
      gate (`transcriptMentionsPricing`) checks the transcript itself
      for actual price language — "rand," "R" followed by a digit,
      "price," "rate," "cost," "charge," "quote," "discount," or "per
      sq/square/m2/metre/meter" — before the pricing extraction is
      ever called at all, on both call sites that could reach it. The
      model is never asked to judge whether a price exists; a
      deterministic check decides that first, matching the exact
      discipline already proven everywhere else in this project. The
      secondary fix: the prompt itself now explicitly states a price
      may not exist at all, includes an instruction that finding
      nothing means returning an empty result rather than inventing
      one, and — critically — includes a real, negative worked example
      showing the exact failure case (the Thabo transcript) correctly
      producing `{"priced_items": []}`. A prompt that never shows what
      "nothing found" looks like implicitly teaches a model that
      finding something is always the expected, correct outcome.
    - **Verified on both sides, not just the failure case.** The exact
      failure transcript, re-run after the fix, correctly produced only
      a job scope, no quotation, `pendingActionId: null`. A genuine,
      correctly-priced case ("twenty square meters... at two hundred
      rand a square meter," a fresh customer to avoid an unrelated
      job-scope-matching ambiguity from the first retest) correctly
      produced a real R4,000 quotation — proving the fix closed the
      hallucination without breaking the real, legitimate case it
      needs to keep working.

## Real, extracted lessons — the CSV import journey

The detailed, blow-by-blow of building customer and invoice bulk
import is already recorded above, entry by entry. This is the
consolidated, forward-looking version — what should actually change
about how future work like this gets done, not a re-telling.

**Test parsers against the real, actual file, never pasted or
reconstructed text.** The very first version of the invoice CSV,
pasted into a chat message, appeared to have real, inconsistent
delimiters (tabs, then semicolons). It didn't — the real, uploaded
file was completely, consistently comma-delimited throughout. The
apparent inconsistency was purely an artifact of the paste. A parser
built to handle a paste-artifact problem that doesn't exist in the
real file is effort spent solving the wrong thing.

**Independently verify a parser against real edge cases before it
touches live code — and this is the one part of the journey that
already worked, worth reinforcing, not just critiquing.** Both the
customer and invoice CSV parsers were written and tested standalone,
against real data extracted from the actual file, before being placed
in `index.ts`. The invoice parser's payment-detail sums were checked
against all 295 real rows, with zero reconciliation mismatches, before
any endpoint used it. This should stay the default for any future
parsing work, not something reached for only when a project feels
important enough.

**A shared field's meaning is a real contract with everything that
already reads it — writing to it isn't enough; what already consumes
it has to be checked too.** The VAT double-charge happened because
`invoices.amount` was silently written as a post-tax total, while the
already-existing PDF logic had always treated that same field as a
pre-tax subtotal and calculated VAT on top of it. Nothing was wrong
with either piece of code in isolation — the bug lived entirely in the
unchecked assumption that both sides agreed on what the field meant.
Before writing new data into an existing table or field, find and read
what already consumes it, not just confirm the column exists and
accepts the value.

**A platform quirk can look like a data problem at first — check the
platform before concluding the data is wrong.** CSV files, especially
Excel-saved ones, are a well-documented `file_picker` limitation on
Android specifically, unrelated to anything about the file itself.
Confirmed directly via search before writing a fix, rather than
guessing at what might be wrong with the file.

**Two similar-looking actions sitting next to each other, both opening
the same generic system file picker, are a real, easy way to select
the wrong one without noticing.** The customer-import and invoice-
import icons look different, but the file picker each one opens looks
identical regardless of which button triggered it — nothing in that
screen tells the person which import they're actually about to run.
Worth a real, named lesson for any future feature with more than one
similar action: the file picker itself carries no context back to the
person using it.

## Real, extracted lessons — the ember positioning escapade

Also already recorded above in the individual commits. This is the
consolidated version.

**A confirmed, correctly-deployed code change producing zero visible
difference is a real, distinct category of problem from "the fix was
wrong" — and it deserves a different, cheaper diagnostic step much
earlier, not three more rounds of the same kind of guess.** Three
separate alignment adjustments were made, each verified present in the
live, deployed code, before a five-minute fix (a visible build-version
marker on screen) actually confirmed the real code was reaching the
device at all. That diagnostic should have been the second move, not
the fourth, the moment a real, dramatic code change produced no
visible effect whatsoever.

**A child that already nearly fills its parent's available space makes
`Align`'s positioning value nearly irrelevant, no matter how dramatic
the value.** The real root cause: an earlier fix grew the ember
container's own height to stop one ember from rendering outside it,
which left almost no real slack in the parent for `Align` to
distribute at all. The lesson generalizes past this one bug: fixing an
overflow by growing a container can silently consume the very room a
sibling or the same widget's own positioning depends on. Check the
full, real parent-child size relationship, not just whether the
immediate overflow is gone.

**When multiple, parallel UI variants exist behind a toggle, confirm
which one is actually active on the real device before diagnosing
anything about its appearance.** Real time was spent reasoning about
whether "old" and "tear" embers were both visible at once before
checking the toggle's actual default value directly in the code — it
defaults false, so only one variant was ever being seen the entire
time.

**A textual description of a UI problem is a real, working hypothesis,
not a confirmed diagnosis — a screenshot resolves ambiguity that
several rounds of careful reasoning cannot.** Multiple, plausible-
sounding but ultimately wrong theories were built from words alone
before the actual, real constraint (a too-small parent height) was
found by directly calculating the numbers. Ask for a screenshot early
in any UI-positioning report, before investing in more than one
theory-driven fix.

---

**Docs pass 7 (2026-10-25).** `ATLAS.md` creation sites re-counted: invoices have four (the two CSV-import paths were missing), job scopes two (`attachToSiblingJobScope` was missing). The invariants hold for the first two invoice paths only; imports are historical records.
