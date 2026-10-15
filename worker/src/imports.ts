// Bulk import of a business's team, suppliers and materials from a spreadsheet (SHIP_CHECKLIST.md item 15, onboarding: "no bulk import exists at all, only one at a time by voice"). Same shape as the customer import: the file is
// read tolerantly (csv-import.ts), the columns are found by name, and the whole import is ONE transaction (all of it happens or none of it does, so a failed import leaves nothing behind and a retry is safe). Importing the same
// file again changes nothing: a name that is already there is MATCHED, not created again.
import { atomically } from "./atomic";
import { PRODUCT_COLUMNS, SUPPLIER_COLUMNS, TEAM_COLUMNS, matchColumns, readCsv } from "./csv-import";
import { looksLikeAName } from "./identity";
import type { Env } from "./types";

export const BULK_IMPORT_MAX_ROWS = 2000;
export type BulkImportKind = "team" | "suppliers" | "products";
const SPECS = { team: TEAM_COLUMNS, suppliers: SUPPLIER_COLUMNS, products: PRODUCT_COLUMNS };
const WHAT = { team: "team member", suppliers: "supplier", products: "product" };

// What a team member's role in the file means here. Nothing written, or an installer-like word, is an installer; a contractor-like word is a subcontractor; anything else (driver, admin, manager) is staff.
export function teamRelationship(role: string | undefined): string {
  const tidy = (role ?? "").trim().toLowerCase();
  if (!tidy || /install|fitter|layer|floor/.test(tidy)) return "installer";
  if (/contract/.test(tidy)) return "subcontractor";
  return "staff";
}

const bad = (error: string, extra: Record<string, unknown> = {}): Response => Response.json({ error, ...extra }, { status: 400 });

export async function bulkImportRoute(request: Request, env: Env, kind: BulkImportKind): Promise<Response> {
  const formData = await request.formData().catch(() => null);
  if (!formData) return bad("send the spreadsheet as a form with a file called csv");
  const csvFile: unknown = formData.get("csv");
  if (!(csvFile instanceof File)) return bad("missing csv file");
  const rows = readCsv(await csvFile.text());
  if (rows.length < 2) return bad("CSV has no data rows");
  if (rows.length - 1 > BULK_IMPORT_MAX_ROWS) return bad(`That file has ${rows.length - 1} rows and the limit is ${BULK_IMPORT_MAX_ROWS}: split it into smaller files`);
  const columns = matchColumns(rows[0], SPECS[kind]);
  const nameAt = columns.index.name;
  if (nameAt === undefined) return bad(`I couldn't find a column with the ${WHAT[kind]}'s name. The columns I found are: ${rows[0].map((h) => h.trim()).filter(Boolean).join(", ")}`, { found: rows[0].map((h) => h.trim()) });
  const roleAt = columns.index.role, categoryAt = columns.index.category;

  return await atomically(env, async (env) => {
    let created = 0, matched = 0, skipped = 0;
    const skippedRows: number[] = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const rawName = row[nameAt]?.replace(/\s+/g, " ").trim();
      if (!rawName || rawName.length > 200) {
        skipped++;
        skippedRows.push(i + 1);
        continue;
      }
      if (kind === "products") {
        const category = categoryAt !== undefined ? row[categoryAt]?.replace(/\s+/g, " ").trim() || null : null;
        const existing = await env.OFFICE_DB.prepare("SELECT id FROM products WHERE lower(trim(name)) = lower(?) AND merged_into_product_id IS NULL LIMIT 1").bind(rawName).first<{ id: number }>();
        if (existing) {
          matched++;
        } else {
          await env.OFFICE_DB.prepare("INSERT INTO products (name, category) VALUES (?, ?)").bind(rawName, category).run();
          created++;
        }
        continue;
      }
      if (!looksLikeAName(rawName)) {
        skipped++;
        skippedRows.push(i + 1);
        continue;
      }
      // EXACT names only (ignoring case and spacing), NOT the loose matching that serves dictation. That matching takes any existing name that merely CONTAINS the first and last word ("John Smith" is "John Smithson",
      // a last name of "A" is anything with an A in it), which is right for a spoken name and wrong for a deliberate list: it would report a team member as "matched" while another person's record stood in for them
      // (seen on real Cloudflare: two runs with names differing only in an id were taken for the same people). A near-duplicate is the lesser harm: the merge routes can join two records, nothing can separate them.
      const existing = await env.OFFICE_DB.prepare("SELECT id FROM characters WHERE lower(trim(name)) = lower(?) AND merged_into_character_id IS NULL LIMIT 1").bind(rawName).first<{ id: number }>();
      if (existing) {
        matched++;
      } else {
        const relationship = kind === "suppliers" ? "supplier" : teamRelationship(roleAt !== undefined ? row[roleAt] : undefined);
        await env.OFFICE_DB.prepare("INSERT INTO characters (name, relationship) VALUES (?, ?)").bind(rawName, relationship).run();
        created++;
      }
    }
    return Response.json({ status: "ok", kind, totalRows: rows.length - 1, created, matched, skipped, skippedRows, columns: { found: columns.found, ignored: columns.ignored } });
  });
}
