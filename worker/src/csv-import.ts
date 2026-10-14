// Reading a spreadsheet export that somebody else's software produced (SHIP_CHECKLIST.md item 15, onboarding). A new business arrives with an export from WHATEVER it used, and the real exports are untidy: Excel puts an
// invisible byte-order mark in front of the first header ("Invoice" becomes "\uFEFFInvoice" and matches nothing); South African regional settings separate fields with semicolons, not commas; the same column is called
// "Invoice", "Invoice No." or "Inv #"; and money is "R1 234,50" as often as "1234.50". Everything here is deterministic (no model): a header is matched by name against a list of aliases, never by guessing.
//
// parseCsv itself is the parser that lived in index.ts, moved unchanged in behaviour for an ordinary comma file; the delimiter is now a parameter.

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// Looks only at the header line (outside quotes) and picks the separator it has most of; a comma when nothing else is there.
export function detectDelimiter(text: string): string {
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0, "|": 0 };
  let inQuotes = false;
  for (const char of stripBom(text)) {
    if (char === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (char === "\n" || char === "\r")) break;
    else if (!inQuotes && char in counts) counts[char]++;
  }
  let best = ",";
  for (const d of [";", "\t", "|"]) if (counts[d] > counts[best]) best = d;
  return best;
}

export function parseCsv(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += char;
      i++;
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (char === delimiter) {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (char === "\r") {
      i++;
      continue;
    }
    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += char;
    i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// What an import calls to read a file: the byte-order mark removed, the delimiter found, a blank line at the end ignored.
export function readCsv(text: string): string[][] {
  const clean = stripBom(text);
  return parseCsv(clean, detectDelimiter(clean)).filter((r, i) => i === 0 || r.some((c) => c.trim() !== ""));
}

// "Invoice No.", "invoice_no", " INVOICE  NO " and "Inv #" are all compared in one tidy form: lower case, punctuation and runs of spaces collapsed to one space.
export function normaliseHeader(h: string): string {
  return stripBom(String(h ?? "")).toLowerCase().replace(/[_\-./#()\[\]:]+/g, " ").replace(/\s+/g, " ").trim();
}

export type ColumnSpec = Record<string, string[]>;   // field -> the (normalised) names it may go by; the first field listed claims a column first

export interface ColumnMatch {
  index: Record<string, number>;      // field -> column number, for the fields that were found
  found: Record<string, string>;      // field -> the header as it was written, for showing the owner what was read
  ignored: string[];                  // headers no field wanted
}

// Exact match on the tidy form, never a "contains": a column called "Total paid" must not be read as the total. Each column is used by at most one field, and the first column wins when two have the same name.
export function matchColumns(header: string[], spec: ColumnSpec): ColumnMatch {
  const tidy = header.map(normaliseHeader);
  const taken = new Set<number>();
  const index: Record<string, number> = {};
  const found: Record<string, string> = {};
  for (const [field, aliases] of Object.entries(spec)) {
    // The aliases are listed most trustworthy first, so "Total" beats "Amount" even when "Amount" is the earlier column; two columns with the same name: the first one.
    let at = -1;
    for (const alias of aliases.map(normaliseHeader)) {
      at = tidy.findIndex((h, i) => !taken.has(i) && h === alias);
      if (at !== -1) break;
    }
    if (at !== -1) {
      taken.add(at);
      index[field] = at;
      found[field] = stripBom(header[at]).trim();
    }
  }
  return { index, found, ignored: header.map((h, i) => (taken.has(i) ? null : stripBom(h).trim())).filter((h): h is string => !!h) };
}

// Money as people write it. "R1,234.50", "R 1 234,50", "1.234,50", "ZAR 99.90", "(100.00)" (a negative), "-R50", "1234". NaN for anything that is not a plain amount. A lone comma followed by one or two digits is a
// decimal comma ("12,50"); a comma followed by three is a thousands separator ("1,234").
export function parseMoney(raw: unknown): number {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : NaN;
  let s = String(raw ?? "").trim();
  if (!s) return NaN;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1).trim();
  }
  s = s.replace(/[\s\u00a0\u202f]/g, "").replace(/^(zar|usd|eur|gbp|r|\$|€|£)/i, "").replace(/(zar|usd|eur|gbp|r)$/i, "");
  if (!s || !/^[\d.,]+$/.test(s)) return NaN;
  // Thousands separators must group in threes ("1,234,567"); anything else ("1.2.3", "12,34,567") is not read at all, so a row is skipped and reported instead of being silently misread.
  const grouped = (text: string, sep: string): boolean => new RegExp(`^\\d{1,3}(\\${sep}\\d{3})+$`).test(text);
  const lastDot = s.lastIndexOf("."), lastComma = s.lastIndexOf(",");
  if (lastDot !== -1 && lastComma !== -1) {
    const decimal = lastDot > lastComma ? "." : ",";
    const thousands = decimal === "." ? "," : ".";
    const whole = s.slice(0, s.lastIndexOf(decimal));
    if (!grouped(whole, thousands) || s.slice(s.lastIndexOf(decimal) + 1).includes(thousands)) return NaN;
    s = whole.split(thousands).join("") + "." + s.slice(s.lastIndexOf(decimal) + 1);
  } else if (lastComma !== -1) {
    if (s.split(",").length === 2 && /,\d{1,2}$/.test(s)) s = s.replace(",", ".");
    else if (grouped(s, ",")) s = s.split(",").join("");
    else return NaN;
  } else if ((s.match(/\./g) || []).length > 1) {
    if (!grouped(s, ".")) return NaN;
    s = s.split(".").join("");
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return NaN;
  const n = Number(s);
  return negative ? -n : n;
}

// The columns each import looks for. Listed in the order they claim a column.
export const INVOICE_COLUMNS: ColumnSpec = {
  invoice: ["invoice", "invoice number", "invoice no", "invoice num", "invoice id", "inv", "inv no", "inv number", "inv num", "document number", "document no", "doc no", "reference", "ref", "number", "no"],
  client: ["client", "client name", "customer", "customer name", "name", "bill to", "billed to", "debtor", "account", "account name"],
  total: ["total", "invoice total", "total amount", "amount", "invoice amount", "gross", "gross amount", "total incl vat", "total inc vat", "total including vat", "total incl", "total zar", "amount incl vat", "amount inc vat", "amount including vat"],   // a column that says EXCL. VAT is deliberately NOT here: a net figure must never be read as the invoice total
  balance: ["balance due", "balance", "outstanding", "amount outstanding", "amount due", "owing", "balance owing", "amount owing"],
  paid: ["paid", "amount paid", "paid amount", "payments received", "received"],
  date: ["date", "invoice date", "issue date", "issued", "date issued", "created", "created date"],
  details: ["payment details", "payments", "payment info", "payment history"],
};
export const TEAM_COLUMNS: ColumnSpec = {
  name: ["name", "full name", "employee", "employee name", "installer", "installer name", "team member", "staff", "staff name", "person"],
  role: ["role", "position", "job title", "title", "type", "relationship", "trade"],
};
export const SUPPLIER_COLUMNS: ColumnSpec = {
  name: ["name", "supplier", "supplier name", "company", "company name", "vendor", "vendor name", "business name", "creditor"],
};
export const PRODUCT_COLUMNS: ColumnSpec = {
  name: ["name", "product", "product name", "material", "material name", "item", "item name", "description"],
  category: ["category", "type", "group", "product category", "material type"],
};
