// The assistant's sentences for the books (docs/decisions/general-ledger.md, G4): "what is my profit this month", "what do I own and owe". As with every sentence: the model supplies WORDS, the engine works the dates out from today,
// nothing is guessed, nothing is written, and only someone who may read the books is offered or answered them.
const kit = require('./engine-kit.js');

module.exports = kit.guard('engine interpret (the books)', async ({ check }) => {
  const ENV_A = { BUSINESS_ID: 'eng-a', ENGINE_REHEARSAL: '1' };
  const SEED = { admin: true, method: 'POST', path: '/admin/engine/provision-sample', body: { confirm: 'eng-a' } };
  const call = (capability, args) => JSON.stringify(capability === null ? { capability: null } : { capability, arguments: args });
  const say = (re, reply) => ({ match: re, reply: () => reply });
  const SCRIPT = [
    say(/profit this month/, call('ledger.profit_and_loss', { period: 'this_month' })),
    say(/profit last month/, call('ledger.profit_and_loss', { period: 'last_month' })),
    say(/What is my profit\?/, call('ledger.profit_and_loss', {})),
    say(/profit for next century/, call('ledger.profit_and_loss', { period: 'next_century' })),
    say(/profit with dates/, JSON.stringify({ capability: 'ledger.profit_and_loss', arguments: { period: 'this_month', from: '2020-01-01', to: '2020-12-31' } })),
    say(/What do I own and owe\?/, call('ledger.balance_sheet', {})),
    say(/balance sheet for last year/, call('ledger.balance_sheet', { asOf: '2025-12-31' })),
    say(/cash flow this month/, call('ledger.cash_flow', { period: 'this_month' })),
    say(/How is cash flow\?/, call('ledger.cash_flow', {})),
    say(/profit this financial year/, call('ledger.profit_and_loss', { period: 'this_financial_year' })),
    say(/profit last financial year/, call('ledger.profit_and_loss', { period: 'last_financial_year' })),
    say(/why did my cash change this month/, call('ledger.cash_flow_indirect', { period: 'this_month' })),
    say(/Close last year\./, call('year.close', { year: 'last_financial_year' })),
    say(/How was last year\?/, call('year.close', { year: 'last_financial_year' })),
    say(/Close the books for 2019\./, call('year.close', { year: '2019' })),
    say(/Close last year with dates\./, JSON.stringify({ capability: 'year.close', arguments: { year: 'last_financial_year', yearEnd: '2019-02-28' } })),
    say(/Is the bank reconciled\?/, call('ledger.bank_reconciliation', {})),
    say(/bank as at March/, call('ledger.bank_reconciliation', { asOf: '2026-03-31' })),
  ];
  const interpret = (text, role = 'accountant', ai = SCRIPT) => kit.route({ env: ENV_A, ai, before: [SEED], method: 'POST', path: '/engine/interpret', role, body: { text } });
  const added = (res, t) => ((res.writes && res.writes[t] && res.writes[t].added) || []).length;
  const tables = (res) => Object.keys(res.writes || {}).filter((t) => added(res, t) > 0).sort();
  const body = (res) => (res.result && res.result.body) || {};
  const status = (res) => res.result && res.result.status;
  const NOT = (res) => status(res) === 422 && body(res).error === 'not_understood';
  const monthOk = (from, to) => /^\d{4}-\d{2}-01$/.test(from) && to.slice(0, 7) === from.slice(0, 7) && Number(to.slice(8)) >= 28;

  let r = await interpret('What is my profit this month?');
  check(status(r) === 200 && body(r).understood.capability === 'ledger.profit_and_loss' && monthOk(body(r).result.from, body(r).result.to) && body(r).result.totals && typeof body(r).result.totals.profitMinor === 'number' && tables(r).every((t) => ['captures', 'eng_interpretation', 'eng_observation'].includes(t)), '"my profit this month" is the engine\'s profit and loss for the calendar month it worked out from today, and nothing but the record of the question is written');
  const tm = body(r).result;
  r = await interpret('What was my profit last month?');
  check(status(r) === 200 && monthOk(body(r).result.from, body(r).result.to) && body(r).result.from < tm.from && body(r).result.to < tm.from, 'last month is the month before');
  r = await interpret('What is my profit?'); check(NOT(r), 'a profit question with no period is not understood (the person is asked, nothing is guessed)');
  r = await interpret('profit for next century'); check(NOT(r), 'a period the catalogue does not have is not understood');
  r = await interpret('profit with dates'); check(NOT(r) || (status(r) === 200 && body(r).result.from === tm.from), 'dates the model adds are never used: either not understood or the engine\'s own month');
  r = await interpret('What do I own and owe?');
  check(status(r) === 200 && body(r).understood.capability === 'ledger.balance_sheet' && /^\d{4}-\d{2}-\d{2}$/.test(body(r).result.asOf) && body(r).result.balanced === true, '"what do I own and owe" is the balance sheet as at today (a date the engine worked out), and it balances');
  r = await interpret('cash flow this month');
  check(status(r) === 200 && body(r).understood.capability === 'ledger.cash_flow' && monthOk(body(r).result.from, body(r).result.to) && body(r).result.balanced === true && tables(r).length === 0, '"cash flow this month" is the engine\'s own month, balanced, and writes nothing');
  r = await interpret('How is cash flow?'); check(NOT(r), 'a cash flow question with no period is not understood');
  r = await interpret('Is the bank reconciled?');
  check(status(r) === 200 && body(r).understood.capability === 'ledger.bank_reconciliation' && body(r).result.statement === null && tables(r).length === 0, '"is the bank reconciled" reads the reconciliation (no statement yet in the sample) and writes nothing');
  r = await interpret('profit this financial year');
  check(status(r) === 200 && body(r).understood.capability === 'ledger.profit_and_loss' && /^\d{4}-\d{2}-01$/.test(body(r).result.from) && body(r).result.to > body(r).result.from && tables(r).length === 0, '"profit this financial year" is the engine\'s own financial year');
  const fyThis = body(r).result;
  r = await interpret('profit last financial year');
  check(status(r) === 200 && body(r).result.to < fyThis.from, 'last financial year is the year before');
  r = await interpret('why did my cash change this month');
  check(status(r) === 200 && body(r).understood.capability === 'ledger.cash_flow_indirect' && typeof body(r).result.agrees === 'boolean' && tables(r).length === 0, '"why did my cash change" is the indirect cash flow for the engine\'s month, and writes nothing');
  r = await interpret('Close last year.', 'owner');
  const noFacts = (res) => !tables(res).some((t) => ['eng_event', 'eng_journal_entry', 'eng_journal_line'].includes(t));
  check(status(r) === 200 && body(r).status === 'held' && body(r).understood.capability === 'year.close' && noFacts(r), '"close last year" is understood as closing a year and is only PROPOSED (held for the owner): no event and no journal entry is written');
  const held = JSON.parse(r.writes.pending_actions.added[0].payload);
  check(held.yearEnd === '2026-02-28' || (/^\d{4}-\d{2}-\d{2}$/.test(held.yearEnd) && held.yearEnd < new Date().toISOString().slice(0, 10) && Object.keys(held).sort().join() === 'reason,yearEnd'), 'the held proposal carries the engine\'s own last year-end, a date already past, and nothing the model chose');
  r = await interpret('Close last year.', 'accountant');
  check(!(status(r) === 200 && body(r).status === 'held') && noFacts(r), 'an accountant cannot even propose closing a year');
  r = await interpret('How was last year?', 'owner'); check(NOT(r), 'a sentence that does not say "close" is never read as closing a year');
  r = await interpret('Close the books for 2019.', 'owner'); check(NOT(r), 'a year the model names is not understood: only the last financial year, dated by the engine');
  r = await interpret('Close last year with dates.', 'owner'); check(NOT(r), 'a date the model adds to a close is not understood');
  r = await interpret('bank as at March'); check(NOT(r), 'a reconciliation date the model supplies is not understood: the engine picks the latest statement');
  r = await interpret('balance sheet for last year'); check(NOT(r), 'a balance sheet the model gave a date for is not understood: the date is the engine\'s, not the model\'s');
  r = await interpret('What is my profit this month?', 'sales');
  check(status(r) !== 200 && !(body(r).result && body(r).result.totals), 'a salesperson is not answered with the books (and is not offered them)');
  const shown = async (role) => { const probe = []; await interpret('Hello there', role, [{ match: /./, reply: (input) => { probe.push(input); return call(null); } }]); return ((probe[0] && probe[0].messages.find((m) => m.role === 'system')) || {}).content || ''; };
  const [forAccountant, forSales, forAdmin] = [await shown('accountant'), await shown('sales'), await shown('admin')];
  check(forAccountant.includes('"id":"ledger.profit_and_loss"') && forAccountant.includes('"id":"ledger.balance_sheet"') && !/ledger\.(profit|balance)/.test(forSales) && !/ledger\.(profit|balance)/.test(forAdmin), 'the model is shown the two book sentences only for someone who may read the books: an accountant yes, a salesperson and an admin never');
  r = await interpret('What is my profit this month?', 'admin');
  check(status(r) !== 200 && !(body(r).result && body(r).result.totals), 'nor is an admin, who may not know profit');
});

if (require.main === module) kit.standalone(module.exports);
