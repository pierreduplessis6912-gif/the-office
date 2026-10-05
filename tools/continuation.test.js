// Tests for the scheduling continuation (found by the first real phone test, 2026-10-04): "...and schedule for the 17th" after an invoice.
module.exports = async function runContinuationTests({ check, bundleTo }) {
  const { schedulingContinuation, describeDate, resolveScheduledDate } = bundleTo('scheduler.ts', 'rm-cont-scheduler.js');
  const now = new Date(2026, 9, 3, 12, 0, 0);   // Saturday 3 October 2026
  const ex = (o) => ({ customer_name: null, character_name: null, character_relationship: null, intent: 'price_scope', amount: null, fact_key: null, fact_value: null, personal_note: null, query_scope: null, deposit_percent: null, scope_document_type: null, due_date_raw: null, ...(o || {}) });
  const withJob = [{ customer: { name: 'AGS' }, jobScopeIdForProjectResolution: 7 }];
  const noJob = [{ customer: { name: 'AGS' }, jobScopeIdForProjectResolution: null }];

  // What it IS: whatever the model labelled it, these become scheduling.
  for (const phrase of ['schedule for the 17th', 'and schedule for the 17th', 'then schedule for the 17th', 'also book it for Monday', 'install on the 17th', 'and fit it tomorrow', 'please schedule it for next Monday', 'start on the 20th', 'plan for the 17th', 'set it for the seventeenth']) {
    for (const label of ['price_scope', 'lookup', 'convert_quote', 'note', 'other', 'work_observation']) {
      const r = schedulingContinuation(phrase, ex({ intent: label, query_scope: label === 'lookup' ? 'business' : null }), withJob, now);
      check(r !== null && r.intent === 'work_observation' && r.customer_name === null && r.query_scope === null, `"${phrase}" read as ${label} becomes scheduling for the job just recorded`);
    }
  }
  const noJobResult = schedulingContinuation('and schedule for the 17th', ex(), noJob, now);
  check(noJobResult !== null && noJobResult.customer_name === 'AGS' && noJobResult.intent === 'work_observation', 'with no job recorded before it, the date is for the customer of the part before it');
  const lastCust = schedulingContinuation('and schedule for the 17th', ex(), [{ customer: { name: 'First' }, jobScopeIdForProjectResolution: null }, { customer: null, jobScopeIdForProjectResolution: null }, { customer: { name: 'Second' }, jobScopeIdForProjectResolution: null }], now);
  check(lastCust !== null && lastCust.customer_name === 'Second', 'and it is the NEAREST earlier customer');

  // What it must NOT be.
  const not = (label, phrase, extraction, earlier) => check(schedulingContinuation(phrase, extraction, earlier, now) === null, `${label}: "${phrase}" is left alone`);
  not('a question', 'what is scheduled for the 17th', ex({ intent: 'lookup' }), withJob);
  not('a question mark', 'schedule for the 17th?', ex(), withJob);
  not('does not start like an instruction', 'the install is the 17th', ex(), withJob);
  not('a statement about a person', 'Jabulani is booked on the 17th', ex(), withJob);
  not('no date', 'and schedule it soon', ex(), withJob);
  not('money (a rand amount)', 'and schedule it for the 17th for R500', ex(), withJob);
  not('money (the word deposit)', 'and schedule for the 17th with a deposit', ex(), withJob);
  not('money (an invoice)', 'and invoice for the 17th', ex(), withJob);
  not('too long to be a fragment', 'and schedule the installation of the whole kitchen floor and the two bedrooms for the 17th at about nine in the morning', ex(), withJob);
  not('it names its own customer', 'and schedule for the 17th', ex({ customer_name: 'Jenny' }), withJob);
  not('it names a supplier or installer', 'and schedule for the 17th', ex({ character_name: 'Sipho' }), withJob);
  not('it has an amount', 'and schedule for the 17th', ex({ amount: 500 }), withJob);
  not('nothing before it', 'and schedule for the 17th', ex(), []);
  not('nothing before it to belong to', 'and schedule for the 17th', ex(), [{ customer: null, jobScopeIdForProjectResolution: null }]);
  check(schedulingContinuation('and schedule for the 17th', ex({ intent: 'price_scope', fact_key: 'x', fact_value: 'y' }), withJob, now).fact_key === null, 'the rewrite clears fields that belonged to the wrong reading');
  const original = ex({ intent: 'price_scope' }); schedulingContinuation('and schedule for the 17th', original, withJob, now);
  check(original.intent === 'price_scope', 'the caller\'s extraction is never modified');

  // The date wording.
  check(describeDate('2026-10-17') === 'Sat 17 Oct' && describeDate('2026-12-01') === 'Tue 1 Dec' && describeDate('2027-01-09') === 'Sat 9 Jan', 'a saved date reads "Sat 17 Oct"');
  check(resolveScheduledDate('and schedule for the 17th', now) === '2026-10-17', 'and the date reader reads the whole fragment');
};
