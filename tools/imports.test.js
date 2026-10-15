// Importing a new business's data from whatever it used before (worker/src/csv-import.ts, imports.ts, the invoice import in index.ts; SHIP_CHECKLIST.md item 15). The old invoice import understood ONE tool's export. Now: any export
// is read by column NAME (with a byte-order mark, semicolons, "Invoice No." or "Inv #", "R1 234,50"); money is never guessed at; importing the same file twice changes nothing (it used to double every invoice); and the new
// team, supplier and materials imports are all-or-nothing like the others.
const path = require('path'), fs = require('fs'), os = require('os'), esbuild = require('esbuild');

module.exports = async function runImportTests(context) {
  const standIn = global.Response;
  if (global.__RealResponse) global.Response = global.__RealResponse;
  try { await importTests(context); } finally { global.Response = standIn; }
};

async function importTests({ check, srcDir }) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'imp-')), 'm.js');
  esbuild.buildSync({ entryPoints: [path.join(srcDir, 'csv-import.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
  const c = require(out), harness = require('./harness.js'), workerDir = path.join(srcDir, '..');

  // ---- the reader ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  check(c.stripBom('\uFEFFInvoice') === 'Invoice' && c.stripBom('Invoice') === 'Invoice' && c.stripBom('') === '', 'a byte-order mark (what Excel puts in front of a "CSV UTF-8" file) is removed, and nothing else is');
  const delims = [c.detectDelimiter('a,b,c\n1,2,3'), c.detectDelimiter('\uFEFFInvoice;Client;Total\n1;x;2'), c.detectDelimiter('a\tb\tc\n1\t2\t3'), c.detectDelimiter('a|b|c\n1|2|3'), c.detectDelimiter('"a,b";c;d\n1;2;3'), c.detectDelimiter('single\nvalue'), c.detectDelimiter('')];
  check(JSON.stringify(delims) === JSON.stringify([',', ';', '\t', '|', ';', ',', ',']), 'the separator is found from the header line: comma, semicolon (South African Excel), tab and pipe; commas inside quotes do not count; a one-column file or an empty one is a comma file');
  check(JSON.stringify(c.parseCsv('a,b\n"x, y","say ""hi"""\r\n1,2\n')) === JSON.stringify([['a', 'b'], ['x, y', 'say "hi"'], ['1', '2']]) && JSON.stringify(c.parseCsv('a;b\n1;2', ';')) === JSON.stringify([['a', 'b'], ['1', '2']]), 'the parser keeps quoted commas, doubled quotes and Windows line endings exactly as before, and takes the delimiter as a parameter');
  check(JSON.stringify(c.readCsv('\uFEFFInvoice;Client\n1;Mrs A\n\n;\n')) === JSON.stringify([['Invoice', 'Client'], ['1', 'Mrs A']]) && c.readCsv('\n\n').length <= 1, 'readCsv strips the mark, finds the delimiter and drops rows with nothing in them (a blank line, or a line of only delimiters)');

  // ---- header matching ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const norm = ['Invoice No.', 'invoice_no', ' INVOICE  NO ', 'Inv #', '\uFEFFInvoice', 'Total (incl. VAT)'].map(c.normaliseHeader);
  check(JSON.stringify(norm) === JSON.stringify(['invoice no', 'invoice no', 'invoice no', 'inv', 'invoice', 'total incl vat']), 'headers are compared in one tidy form: case, punctuation, runs of spaces and the byte-order mark do not matter');
  const m1 = c.matchColumns(['\uFEFFInvoice No.', 'Customer Name', 'Amount (incl. VAT)', 'Balance', 'Notes'], c.INVOICE_COLUMNS);
  check(m1.index.invoice === 0 && m1.index.client === 1 && m1.index.total === 2 && m1.index.balance === 3 && m1.found.invoice === 'Invoice No.' && JSON.stringify(m1.ignored) === JSON.stringify(['Notes']), 'real-world names are found ("Invoice No.", "Customer Name", "Amount (incl. VAT)", "Balance"), the header is reported as the owner wrote it (without the mark), and unused columns are listed');
  const m2 = c.matchColumns(['Amount', 'Customer', 'Total', 'Total excl. VAT', 'Inv #'], c.INVOICE_COLUMNS);
  check(m2.found.total === 'Total' && m2.found.invoice === 'Inv #' && m2.ignored.includes('Amount') && m2.ignored.includes('Total excl. VAT'), 'the most trustworthy name wins even when a weaker one comes first ("Total" beats an earlier "Amount"), and a net column is never used');
  check(c.matchColumns(['Customer', 'Total excl. VAT'], c.INVOICE_COLUMNS).index.total === undefined && c.matchColumns(['Customer', 'Total paid'], c.INVOICE_COLUMNS).index.total === undefined, 'a column that merely CONTAINS "total" ("Total paid", "Total excl. VAT") is not the total: matching is exact, never "contains"');
  const m3 = c.matchColumns(['Name', 'Name', 'Total', 'Invoice', 'Invoice'], { n: ['name'], inv: ['invoice'] });
  check(m3.index.n === 0 && m3.index.inv === 3 && m3.ignored.join() === 'Name,Total,Invoice', 'two columns with the same name: the first is used and the other is left out');

  // ---- money --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const good = { 'R1,234.50': 1234.5, 'R 1 234,50': 1234.5, '1.234,50': 1234.5, 'ZAR 99.90': 99.9, '(100.00)': -100, '-R50': -50, '1234': 1234, '12,5': 12.5, '1,234': 1234, '1.234.567': 1234567, '1,234,567.89': 1234567.89, '1.5': 1.5, '1000': 1000, ' 250 ': 250, '1\u00a0234,50': 1234.5, 'R0': 0 };
  check(Object.entries(good).every(([k, v]) => c.parseMoney(k) === v), `money is read as people write it (${Object.keys(good).length} forms, from "R1,234.50" to "R 1 234,50" to "(100.00)")`);
  const bad = ['abc', '', 'R', '1.2.3', '12,34,567', '1234,5678', '1,234.5,6', '1..2', '12abc', 'R1,2,3', '--5', null, undefined, NaN, {}];
  check(bad.every((v) => Number.isNaN(c.parseMoney(v))) && c.parseMoney(42) === 42, 'anything that is not a plain amount is NaN, never a guess: "1.2.3" is not 123 and "12,34,567" is not read at all, so the row is skipped and reported instead of silently misread');

  // ---- the invoice import, through the real gate ------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const fns = await harness.loadFunctions(workerDir);
  const csv = (text) => ({ csv: { text, name: 'x.csv', type: 'text/csv' } });
  const route = (spec) => harness.runRouteCase(fns, workerDir, { kind: 'route', method: 'POST', ...spec });
  const added = (r, table) => (r.writes && r.writes[table] && r.writes[table].added) || [];
  const nothing = (r) => (Array.isArray(r.writes) ? r.writes.length : Object.keys(r.writes || {}).length) === 0;
  const withBackend = async (backend, fn) => { const saved = process.env.HARNESS_BACKEND; if (backend) process.env.HARNESS_BACKEND = backend; else delete process.env.HARNESS_BACKEND; try { return await fn(); } finally { if (saved === undefined) delete process.env.HARNESS_BACKEND; else process.env.HARNESS_BACKEND = saved; } };
  const IMP = '/files/invoices-csv-import';

  const simple = await route({ name: 'invoice simple', path: IMP, form: csv('Invoice,Date,Client,Total,Paid,Balance due,Payment details\nIS-1,2026-10-01,Mrs Dlamini,500.00,500.00,0.00,500.00;2026-10-02;EFT\nIS-2,2026-10-03,Mr Nkosi,300.00,0.00,300.00,\n') });
  const sb = simple.result.body, sHeld = added(simple, 'pending_actions')[0];
  check(simple.result.status === 200 && sb.imported === 1 && sb.heldForConfirmation === 1 && sb.skipped === 0 && sb.alreadyImported === 0 && added(simple, 'invoices')[0].description === 'Imported invoice IS-1 (Invoice Simple)' && added(simple, 'payments').length === 1 && added(simple, 'payments')[0].amount === 500 && sHeld.type === 'imported_invoice' && /Imported invoice IS-2 \(Invoice Simple\)/.test(sHeld.payload), 'an INVOICE SIMPLE export behaves exactly as before: the settled invoice is recorded with its payment and the Invoice Simple label, the one still owed is held for confirmation');

  const generic = await route({ name: 'generic export', path: IMP, form: csv('\uFEFFInvoice No.;Customer Name;Amount (incl. VAT);Balance;Invoice Date\nINV-10;Mrs Dlamini;R1 500,00;R0,00;2026-10-01\nINV-11;Mr Nkosi;R2 300,50;R2 300,50;2026-10-02\n') });
  const gb = generic.result.body, gp = added(generic, 'payments');
  check(generic.result.status === 200 && gb.imported === 1 && gb.heldForConfirmation === 1 && added(generic, 'invoices')[0].amount === 1500 && added(generic, 'invoices')[0].description === 'Imported invoice INV-10 (CSV import)' && gp.length === 1 && gp[0].amount === 1500 && /settled per the file/.test(gp[0].source_transcript) && JSON.parse(added(generic, 'pending_actions')[0].payload).amount === 2300.5, 'an export from ANOTHER tool works: a semicolon file with a byte-order mark, "Invoice No.", "Customer Name", "Amount (incl. VAT)" and "R1 500,00" is read; the settled invoice gets its payment (so the balance is not inflated) and the unpaid one is held');
  check(JSON.stringify(gb.columns.found) === JSON.stringify({ invoice: 'Invoice No.', client: 'Customer Name', total: 'Amount (incl. VAT)', balance: 'Balance', date: 'Invoice Date' }) && gb.columns.ignored.length === 0, 'the answer says which columns were read, so the app can show the owner what the file was taken to mean');

  const paidCol = await route({ name: 'paid column', path: IMP, form: csv('Customer,Total,Paid\nMrs A,100,100\nMr B,200,50\n') });
  check(paidCol.result.status === 200 && paidCol.result.body.imported === 1 && paidCol.result.body.heldForConfirmation === 1 && added(paidCol, 'invoices')[0].description === 'Imported invoice R100.00 (CSV import)' && added(paidCol, 'payments')[0].amount === 100 && JSON.parse(added(paidCol, 'pending_actions')[0].payload).description === 'Imported invoice R200.00 (CSV import)', 'with only a "Paid" column, what is owed is worked out (total less paid): paid in full is recorded with its payment, part-paid is held; with no invoice number column the amount stands in for it');

  const noMoney = await route({ name: 'cannot tell paid', path: IMP, form: csv('Customer,Total\nMrs A,100\n') });
  check(noMoney.result.status === 400 && /can't tell which invoices are already paid/.test(noMoney.result.body.error) && noMoney.result.body.found.join() === 'Customer,Total' && nothing(noMoney), 'a file with no way to tell paid from owed is REFUSED with the reason and the columns it found, and nothing is written (money is never guessed at)');
  const noTotal = await route({ name: 'no total', path: IMP, form: csv('Customer,Notes,Paid\nMrs A,hello,1\n') }), netOnly = await route({ name: 'net only', path: IMP, form: csv('Customer,Total excl. VAT,Paid\nMrs A,100,100\n') });
  check(noTotal.result.status === 400 && /couldn't find the columns I need/.test(noTotal.result.body.error) && netOnly.result.status === 400 && /EXCL\. VAT is not used as the total/.test(netOnly.result.body.error) && nothing(noTotal) && nothing(netOnly), 'a file with no total, or only a total EXCLUDING VAT, is refused and says so (a net figure is never read as the invoice total)');
  const noClient = await route({ name: 'no client', path: IMP, form: csv('Invoice,Total,Paid\n1,100,100\n') });
  check(noClient.result.status === 400 && nothing(noClient), 'a file with no customer column is refused');

  const odd = await route({ name: 'odd totals', path: IMP, form: csv('Invoice,Client,Total,Paid\nA1,Mrs A,abc,0\nA2,Mrs B,0,0\nA3,Mrs C,-50,0\nA4,Mrs D,R100,R100\nA5,,100,100\n') });
  check(odd.result.body.imported === 1 && odd.result.body.skipped === 4 && odd.result.body.skippedRows.join() === '2,3,4,6' && added(odd, 'invoices').length === 1 && added(odd, 'invoices')[0].amount === 100, 'a total that is a word, zero or negative (a credit note), and a row with no customer, are SKIPPED and reported by row number, never imported as invoices; the good row still goes in');

  // safe to retry: importing the same file twice changes nothing the second time
  const twice = await route({ name: 'again', path: IMP, form: csv('Invoice,Date,Client,Total,Paid,Balance due,Payment details\nIS-1,2026-10-01,Mrs Dlamini,500.00,500.00,0.00,500.00;2026-10-02;EFT\nIS-2,2026-10-03,Mr Nkosi,300.00,0.00,300.00,\n'), before: [{ route: true, method: 'POST', path: IMP, form: csv('Invoice,Date,Client,Total,Paid,Balance due,Payment details\nIS-1,2026-10-01,Mrs Dlamini,500.00,500.00,0.00,500.00;2026-10-02;EFT\nIS-2,2026-10-03,Mr Nkosi,300.00,0.00,300.00,\n') }] });
  check(twice.result.body.imported === 0 && twice.result.body.heldForConfirmation === 0 && twice.result.body.alreadyImported === 2 && nothing(twice), 'SAFE TO RETRY: importing the same file a second time brings in nothing (2 already imported) and writes nothing; before this it doubled every invoice, including the ones waiting for confirmation');
  const inFile = await route({ name: 'duplicate rows', path: IMP, form: csv('Invoice,Client,Total,Paid\nD1,Mrs A,100,100\nD1,Mrs A,100,100\nD2,Mrs A,50,50\n') });
  check(inFile.result.body.imported === 2 && inFile.result.body.alreadyImported === 1 && added(inFile, 'invoices').length === 2, 'the same invoice twice in ONE file is brought in once');
  const sameNumberOtherClient = await route({ name: 'same number other client', path: IMP, form: csv('Invoice,Client,Total,Paid\nD1,Mrs A,100,100\nD1,Mrs B,100,100\n') });
  check(sameNumberOtherClient.result.body.imported === 2 && sameNumberOtherClient.result.body.alreadyImported === 0, 'the same invoice number for two DIFFERENT customers is two invoices');

  const custBom = await route({ name: 'customers bom', path: '/files/customers-csv-import', form: csv('\uFEFFName;Address\nMrs A;1 Road\nMr B;2 Street\n') });
  check(custBom.result.status === 200 && custBom.result.body.created === 2 && added(custBom, 'customers').length === 2 && added(custBom, 'customers')[0].address === '1 Road', 'the CUSTOMER import now reads a file with a byte-order mark and semicolons too');

  // ---- customers in an import: the EXACT name first, the loose match only after it, and every loose match REPORTED ------------------------------------------------------------------------------------------------
  // The matching that serves dictation takes any existing name that contains the first and last word, so with "Mrs Nkosi" and "Mr Nkosi" on file an invoice for "Mr Nkosi" could be posted to Mrs Nkosi: money on the wrong
  // customer. An import now looks for the exact name (ignoring case and spacing) first; only when there is none does it fall back to the loose match, and it says so, row by row, so the owner can check.
  const twoNkosi = (db) => db.exec("INSERT INTO customers (name) VALUES ('Mrs Nkosi'), ('Mr Nkosi')");
  const attrib = await route({ name: 'exact customer wins', path: IMP, seed: twoNkosi, form: csv('Invoice,Client,Total,Paid\nN1,Mr Nkosi,100,100\nN2,mrs   NKOSI,200,200\nN3,MR NKOSI,300,300\n') });
  const attribInv = added(attrib, 'invoices');
  check(attrib.result.status === 200 && attribInv.length === 3 && attribInv[0].customer_id === 2 && attribInv[1].customer_id === 1 && attribInv[2].customer_id === 2 && attrib.result.body.looselyMatched === 0 && attrib.result.body.looseMatches.length === 0 && added(attrib, 'customers').length === 0, 'with Mrs Nkosi and Mr Nkosi both on file, an invoice for "Mr Nkosi" lands on MR Nkosi and "mrs   NKOSI" on Mrs Nkosi (the exact name, ignoring case and spacing, wins), nothing is called a loose match, and nobody new is created');
  const loose = await route({ name: 'loose reported', path: IMP, seed: (db) => db.exec("INSERT INTO customers (name) VALUES ('John Smithson')"), form: csv('Invoice,Client,Total,Paid\nL1,John Smith,100,100\nL2,Brand New Person,50,50\nL3,John Smithson,25,25\n') });
  check(loose.result.body.looselyMatched === 1 && JSON.stringify(loose.result.body.looseMatches) === JSON.stringify([{ row: 2, asked: 'John Smith', matchedTo: 'John Smithson' }]) && added(loose, 'customers').map((x) => x.name).join() === 'Brand New Person' && added(loose, 'invoices').length === 3, 'when there is NO exact name the loose match still happens (as it always did) but is REPORTED with the row, the name in the file and the customer it was taken for; a genuinely new name is created; an exact name is not reported');
  const custLoose = await route({ name: 'customers loose reported', path: '/files/customers-csv-import', seed: (db) => db.exec("INSERT INTO customers (name) VALUES ('John Smithson'), ('Mrs Nkosi'), ('Mr Nkosi')"), form: csv('Name\nJohn Smith\nMr Nkosi\nNew Customer\n') });
  check(custLoose.result.body.created === 1 && custLoose.result.body.matched === 2 && custLoose.result.body.looselyMatched === 1 && custLoose.result.body.looseMatches[0].asked === 'John Smith' && custLoose.result.body.looseMatches[0].matchedTo === 'John Smithson', 'the CUSTOMER import reports its loose matches the same way ("Mr Nkosi" is exact, "John Smith" is the loose one)');
  const manyLoose = await route({ name: 'many loose', path: IMP, seed: (db) => db.exec("INSERT INTO customers (name) VALUES ('John Smithson')"), form: csv('Invoice,Client,Total,Paid\n' + Array.from({ length: 205 }, (_, i) => `M${i},John Smith,10,10`).join('\n') + '\n') });
  check(manyLoose.result.body.looselyMatched === 1 && manyLoose.result.body.looseMatches.length === 1, 'the SAME loose match repeated down a file is reported once per name, not once per row');

  // ---- the three bulk imports -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const TEAM = '/files/team-csv-import', SUP = '/files/suppliers-csv-import', PRO = '/files/products-csv-import';
  const team = await route({ name: 'team', path: TEAM, form: csv('\uFEFFName;Role\nSipho Dlamini;Installer\nThabo Mokoena;Driver\nJohn Fitters;Sub-contractor\nLerato Khumalo;\n') });
  const rel = Object.fromEntries(added(team, 'characters').map((x) => [x.name, x.relationship]));
  check(team.result.status === 200 && team.result.body.created === 4 && team.result.body.matched === 0 && team.result.body.kind === 'team' && rel['Sipho Dlamini'] === 'installer' && rel['Thabo Mokoena'] === 'staff' && rel['John Fitters'] === 'subcontractor' && rel['Lerato Khumalo'] === 'installer' && team.result.body.columns.found.role === 'Role', 'TEAM import (a semicolon file with a mark): installers, a driver as staff, a contractor as subcontractor, and a blank role as installer');
  const supp = await route({ name: 'suppliers', path: SUP, form: csv('Supplier Name,Phone\nFloor & Decor (Pty) Ltd,011\n3M South Africa,012\n,013\n') });
  check(supp.result.status === 200 && supp.result.body.created === 2 && supp.result.body.skipped === 1 && supp.result.body.skippedRows.join() === '4' && added(supp, 'characters').every((x) => x.relationship === 'supplier') && supp.result.body.columns.ignored.join() === 'Phone', 'SUPPLIER import: company names are accepted, a blank name is skipped and reported, the extra column is listed as ignored');
  const prod = await route({ name: 'products', path: PRO, form: csv('Material,Category\nVinyl plank,Flooring\nCarpet tile,Flooring\nvinyl PLANK,Flooring\nScreed,\n') });
  check(prod.result.status === 200 && prod.result.body.created === 3 && prod.result.body.matched === 1 && added(prod, 'products').map((x) => x.name).join() === 'Vinyl plank,Carpet tile,Screed' && added(prod, 'products')[0].category === 'Flooring' && added(prod, 'products')[2].category === null, 'MATERIALS import: a repeat in a different case is the same product, the category is kept when given');
  for (const [label, path_, body] of [['team', TEAM, 'Name,Role\nSipho Dlamini,Installer\nThabo Mokoena,Driver\n'], ['suppliers', SUP, 'Supplier\nVinyl World\nTile Co\n'], ['products', PRO, 'Product\nVinyl\nScreed\n']]) {
    const again = await route({ name: label + ' again', path: path_, form: csv(body), before: [{ route: true, method: 'POST', path: path_, form: csv(body) }] });
    check(again.result.status === 200 && again.result.body.created === 0 && again.result.body.matched === 2 && nothing(again), `SAFE TO RETRY (${label}): importing the same file again creates nothing and writes nothing`);
  }
  // DIFFERENT people with SIMILAR names stay different. The name matching that helps dictation ("Smith" is "Smithson", any "A" is any name containing an A) is far too loose for a deliberate list: it would report
  // a team member as "matched" while someone else's record stands in for them. Found on real Cloudflare (two runs with names differing only in an id were taken for the same people). A bulk import matches EXACT names only.
  const similar = await route({ name: 'similar names', path: TEAM, seed: (db) => { db.exec("INSERT INTO characters (name, relationship) VALUES ('John Smithson', 'installer'), ('Annette Leeds', 'staff'), ('Installer r1 A', 'installer')"); }, form: csv('Name,Role\nJohn Smith,Installer\nAnn Lee,Installer\nInstaller r2 A,Installer\nsipho  DLAMINI,Installer\nSipho Dlamini,Installer\n') });
  const simNames = added(similar, 'characters').map((x) => x.name);
  check(similar.result.body.created === 4 && similar.result.body.matched === 1 && simNames.join() === 'John Smith,Ann Lee,Installer r2 A,sipho DLAMINI', 'a team import keeps similar-but-different people APART ("John Smith" is not "John Smithson", "Ann Lee" is not "Annette Leeds", "Installer r2 A" is not "Installer r1 A") and matches only EXACT names, ignoring case and spacing (the second "Sipho Dlamini" is the first)');
  const sameElsewhere = await route({ name: 'same name other relationship', path: SUP, seed: (db) => { db.exec("INSERT INTO characters (name, relationship) VALUES ('Vinyl World', 'installer')"); }, form: csv('Supplier\nVinyl World\n') });
  check(sameElsewhere.result.body.matched === 1 && sameElsewhere.result.body.created === 0 && nothing(sameElsewhere), 'a name that is already there (whatever it is recorded as) is matched, not created a second time');
  const junkName = await route({ name: 'not a name', path: TEAM, form: csv('Name\nA\nSipho Dlamini\n') });
  check(junkName.result.body.created === 1 && junkName.result.body.skipped === 1 && junkName.result.body.skippedRows.join() === '2', 'a "name" that is not a name (one letter) is skipped and reported, as it always was');
  const noName = await route({ name: 'no name column', path: TEAM, form: csv('Role,Phone\nInstaller,011\n') }), noRows = await route({ name: 'no rows', path: SUP, form: csv('Supplier\n') }), noFile = await route({ name: 'no file', path: PRO, form: { other: 'x' } });
  check(noName.result.status === 400 && /couldn't find a column with the team member's name/.test(noName.result.body.error) && noName.result.body.found.join() === 'Role,Phone' && noRows.result.status === 400 && /no data rows/.test(noRows.result.body.error) && noFile.result.status === 400 && /missing csv file/.test(noFile.result.body.error) && nothing(noName), 'a file with no name column (it lists what it found), with no rows, or with no file is a 400 and writes nothing');
  const big = 'Supplier\n' + Array.from({ length: 2001 }, (_, i) => `Supplier ${i}`).join('\n') + '\n';
  const bigR = await route({ name: 'too big', path: SUP, form: csv(big) });
  check(bigR.result.status === 400 && /2001 rows and the limit is 2000/.test(bigR.result.body.error) && nothing(bigR), 'more than 2,000 rows is refused with a clear reason (split the file), and nothing is written');
  for (const role of ['accountant', 'installer']) {
    const rs = []; for (const p of [TEAM, SUP, PRO]) rs.push(await route({ name: role + ' ' + p, path: p, role, form: csv('Name\nX Y\n') }));   // one at a time: the harness records one request at a time
    check(rs.every((r) => r.result.status === 403 && nothing(r)), `an ${role} is REFUSED on all three bulk imports (403) and nothing is written`);
  }
  const anon = []; for (const p of [TEAM, SUP, PRO]) anon.push(await route({ name: 'anon ' + p, path: p, noSession: true, form: csv('Name\nX Y\n') }));
  check(anon.every((r) => r.result.status === 401), 'a signed-out caller is refused (401) on all three');

  // all or nothing: a failure at ANY write position leaves the business exactly as it was
  for (const [label, path_, body] of [['team', TEAM, 'Name,Role\nSipho Dlamini,Installer\nThabo Mokoena,Driver\nLerato Khumalo,\n'], ['products', PRO, 'Product,Category\nVinyl,Flooring\nScreed,Floor prep\nGrout,Tiling\n']]) {
    const normal = await withBackend('do', () => route({ name: label + ' counted', path: path_, form: csv(body), failAtWrite: 0 }));
    const total = normal.writeCount; let leaks = 0, notFailed = 0;
    for (const k of [1, Math.ceil(total / 2), total]) {
      const r = await withBackend('do', () => route({ name: `${label} fails at ${k}`, path: path_, form: csv(body), failAtWrite: k }));
      // with a failure injected the handler throws (the front door turns that into a clean 500 in production); what matters is that the request FAILS and nothing is left behind
      if (!(r.threw && /injected failure at write/.test(String(r.threw.message || r.threw)))) notFailed++;
      if (!nothing(r)) leaks++;
    }
    check(normal.result.status === 200 && total >= 3 && leaks === 0 && notFailed === 0, `ALL OR NOTHING (${label}): failing the real import at its first, middle and last of ${total} writes fails the request and leaves NOTHING behind`);
  }

  // ---- wiring -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const idx = fs.readFileSync(path.join(srcDir, 'index.ts'), 'utf8');
  check(['team', 'suppliers', 'products'].every((k) => new RegExp(`pathname === "/files/${k}-csv-import" && request\\.method === "POST"\\) return await bulkImportRoute\\(request, env, "${k}"\\)`).test(idx)) && !/function parseCsv/.test(idx) && /readCsv\(text\)/.test(idx), 'the three routes are wired in the conventional shape, and the old parser no longer lives in index.ts');
}
