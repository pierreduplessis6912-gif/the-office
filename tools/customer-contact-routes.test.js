// The customer list and the customer edit route with phone and email (worker/src/index.ts). What this pins: the list carries phone and email and can be searched by them; the edit route sets a phone number only if it is a real one (kept in international form) and an email only if it looks like one, clears either with an empty string, and refuses anything else WHOLE (nothing is changed); and the rules about who may do it are exactly the ones the route had before.
const path = require('path');

module.exports = async function runContactRouteTests({ check, srcDir }) {
  const harness = require('./harness.js'), workerDir = path.join(srcDir, '..'), fns = await harness.loadFunctions(workerDir);
  const route = (spec) => harness.runRouteCase(fns, workerDir, { env: { BUSINESS_ID: 'acme-co' }, ...spec });
  const seed = (db) => { db.exec('PRAGMA foreign_keys = OFF'); db.prepare("INSERT INTO customers (name, address, phone, email) VALUES ('Mr Buitendacht', '22 Haakdoringrug', '+27 81 234 5675', 'b@x.co')").run(); db.prepare("INSERT INTO customers (name) VALUES ('Jenny')").run(); };
  const patch = (body, spec = {}) => route({ name: 'patch ' + JSON.stringify(body).slice(0, 40), method: 'PATCH', path: '/customers/1', body, role: 'owner', seed, ...spec });
  const unchanged = (r) => !r.writes.customers;

  { const r = await route({ name: 'list', method: 'GET', path: '/customers', role: 'owner', seed }), items = r.result.body.items, b = items.find((x) => x.name === 'Mr Buitendacht'), j = items.find((x) => x.name === 'Jenny');
    check(r.result.status === 200 && b.phone === '+27 81 234 5675' && b.email === 'b@x.co' && b.address === '22 Haakdoringrug' && j.phone === null && j.email === null && 'created_at' in b, 'the customer list carries each customer\'s phone and email (empty for one that has none)'); }
  { const a = await route({ name: 'search phone', method: 'GET', path: '/customers?search=81%20234', role: 'owner', seed }), b = await route({ name: 'search email', method: 'GET', path: '/customers?search=b%40x', role: 'owner', seed }), c = await route({ name: 'search none', method: 'GET', path: '/customers?search=zzz', role: 'owner', seed });
    check(a.result.body.items.map((x) => x.name).join() === 'Mr Buitendacht' && b.result.body.items.map((x) => x.name).join() === 'Mr Buitendacht' && c.result.body.items.length === 0, 'the list can be searched by part of a phone number or an email as well as by name and address'); }
  { const r = await patch({ phone: '0812345675', email: '  Pierre@Example.COM ' }, { seed: (db) => { seed(db); db.prepare("UPDATE customers SET phone = NULL, email = NULL WHERE id = 1").run(); } }), w = r.writes.customers.changed;
    check(r.result.status === 200 && w.length >= 1 && w[w.length - 1].after.phone === '+27 81 234 5675' && w[w.length - 1].after.email === 'pierre@example.com' && w[w.length - 1].after.name === 'Mr Buitendacht', 'the edit route saves a valid phone number in international form and an email lower-cased and trimmed, and leaves the name alone'); }
  { const r = await patch({ phone: '', email: '' }), last = r.writes.customers.changed.slice(-1)[0].after;
    check(r.result.status === 200 && last.phone === null && last.email === null && last.address === '22 Haakdoringrug', 'an empty string CLEARS the phone or the email, and nothing else on the customer changes'); }
  { const r = await patch({ name: 'Mr H Buitendacht', address: '1 New Road' }), last = r.writes.customers.changed.slice(-1)[0].after;
    check(r.result.status === 200 && last.name === 'Mr H Buitendacht' && last.address === '1 New Road' && last.phone === '+27 81 234 5675' && last.email === 'b@x.co', 'editing only the name and address (as before) leaves the phone and email as they were'); }
  { const bad = []; for (const body of [{ phone: '123' }, { phone: 'call me' }, { phone: 5 }, { phone: null }, { phone: ['0812345675'] }, { email: 'not an email' }, { email: 'a@b' }, { email: 7 }, { email: 'a'.repeat(260) + '@x.co' }, { phone: '0812345675', email: 'bad' }, { name: 'Changed', phone: 'bad' }, { address: '9 Other Road', email: 'bad' }]) { const r = await patch(body); bad.push(r.result.status === 400 && unchanged(r)); }
    check(bad.every(Boolean), 'a phone that is not a real number, an email that is not one, or the wrong kind of value is refused (400) WHOLE: a good name or address sent with it is not saved either, and nothing changes'); }
  { const r = await patch({ phone: '0812345675' }, { path: '/customers/999' }); check(r.result.status === 404 && unchanged(r), 'a customer that does not exist is a 404'); }
  { const out = []; for (const role of ['accountant', 'installer', 'sales', 'admin']) { const r = await patch({ phone: '0821234567' }, { role }); out.push([role, r.result.status, !!r.writes.customers]); }
    const unauth = await patch({ phone: '0812345675' }, { noSession: true });
    check(unauth.result.status === 401 && out.every(([, status, wrote]) => (status === 200) === wrote), 'who may edit a customer is exactly as before (' + JSON.stringify(out.map(([r, s]) => r + ':' + s)) + '): the new fields are behind the same gate, and nobody signed out can'); }
};
