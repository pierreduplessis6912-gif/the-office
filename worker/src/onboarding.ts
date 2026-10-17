// The owner's first-run journey (SHIP_CHECKLIST.md item 15; ONBOARDING_JOURNEY.md): a short list of steps that turn a blank business into THEIR business. Talking to it never waits on any of this (the journey is additive).
//
// Resumable, persistent and safe to retry, by construction: a step is "done" when the DATA says so (customers exist, a first sentence was said), worked out each time it is asked, so it can never go stale or be lost;
// the only thing stored is what the owner chose (`onboarding_progress`: 'done' by hand, or 'skipped' for later). Asking is a read. Marking is an upsert or a delete, so doing it twice is the same as once.
// The milestone "did you know" moments of the design are the same list with a different trigger, so they will read this and not duplicate it.
import type { Env } from "./types";

export const ONBOARDING_STEPS = [
  { id: "profile", title: "Your business details", detail: "Name, VAT number, address and logo, so your quotes and invoices carry them.", action: "business_profile", upload: null },
  { id: "customers", title: "Bring in your customers", detail: "Import a list of customers from a spreadsheet (CSV), or just start mentioning them.", action: "import_customers", upload: "/files/customers-csv-import" },
  { id: "invoices", title: "Bring in your past invoices", detail: "Import your invoice history so balances and statements are right from day one.", action: "import_invoices", upload: "/files/invoices-csv-import" },
  { id: "team", title: "Add your team", detail: "The installers and staff who use it or come up in jobs.", action: "add_team", upload: "/files/team-csv-import" },
  { id: "suppliers", title: "Add your suppliers", detail: "The people you buy materials from.", action: "add_suppliers", upload: "/files/suppliers-csv-import" },
  { id: "products", title: "Add the materials you work with", detail: "For example vinyl, carpet tile, screed, so they are recognised from the first quote.", action: "add_products", upload: "/files/products-csv-import" },
  { id: "try_it", title: "Say your first sentence", detail: "Try: \"Quote Mrs Dlamini R500 for general repairs.\"", action: "try_saying", upload: null },
] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number]["id"];
export type OnboardingStatus = "done" | "skipped" | "pending";

export interface OnboardingStep {
  id: OnboardingStepId;
  title: string;
  detail: string;
  action: string;
  upload: string | null;               // the route a spreadsheet for this step is sent to (POST, a form with a file called csv); null when the step is not an upload
  status: OnboardingStatus;
  source: "data" | "marked" | null;   // done BECAUSE the data exists, or because the owner marked it; null when pending
}

export interface OnboardingState {
  steps: OnboardingStep[];
  complete: boolean;                   // every step is done or skipped
  remaining: number;                   // steps still pending
  next: OnboardingStepId | null;       // the first pending step, in order
}

// What each step looks for in the business's own data. A table that is missing or a query that fails means "not done", never an error.
const DATA_CHECKS: Record<OnboardingStepId, string> = {
  // The name AND the address: a signup seeds the name from its form (profile-seed.ts), and a step that read "done" on the name alone would never ask for the address that quotes and invoices carry.
  profile: "SELECT COUNT(*) AS n FROM business_profile WHERE name IS NOT NULL AND TRIM(name) != '' AND address IS NOT NULL AND TRIM(address) != ''",
  customers: "SELECT COUNT(*) AS n FROM customers",
  invoices: "SELECT COUNT(*) AS n FROM invoices",
  team: "SELECT (SELECT COUNT(*) FROM memberships WHERE status = 'active') + (SELECT COUNT(*) FROM characters WHERE relationship IN ('installer', 'subcontractor', 'employee', 'staff')) AS n",
  suppliers: "SELECT COUNT(*) AS n FROM characters WHERE relationship = 'supplier'",
  products: "SELECT COUNT(*) AS n FROM products",
  try_it: "SELECT COUNT(*) AS n FROM captures",
};
// The team step counts the owner's own membership as one, so it needs two or more people to be done on data alone.
const DATA_THRESHOLD: Partial<Record<OnboardingStepId, number>> = { team: 2 };

async function dataSaysDone(env: Env, id: OnboardingStepId): Promise<boolean> {
  try {
    const row = await env.OFFICE_DB.prepare(DATA_CHECKS[id]).first<{ n: number }>();
    return Number(row?.n ?? 0) >= (DATA_THRESHOLD[id] ?? 1);
  } catch {
    return false;
  }
}

async function markedSteps(env: Env): Promise<Map<string, "done" | "skipped">> {
  const marked = new Map<string, "done" | "skipped">();
  try {
    const { results } = await env.OFFICE_DB.prepare("SELECT step, status FROM onboarding_progress").all<{ step: string; status: string }>();
    for (const r of results ?? []) if (r.status === "done" || r.status === "skipped") marked.set(r.step, r.status);
  } catch {
    // the table is not there yet (an object that has not applied its schema steps): nothing has been marked
  }
  return marked;
}

export async function onboardingState(env: Env): Promise<OnboardingState> {
  const marked = await markedSteps(env);
  const steps: OnboardingStep[] = [];
  for (const s of ONBOARDING_STEPS) {
    const fromData = await dataSaysDone(env, s.id);
    const mark = marked.get(s.id);
    // The data wins: a step skipped last week and done since is done.
    const status: OnboardingStatus = fromData ? "done" : mark ?? "pending";
    steps.push({ ...s, status, source: fromData ? "data" : mark ? "marked" : null });
  }
  const pending = steps.filter((s) => s.status === "pending");
  return { steps, complete: pending.length === 0, remaining: pending.length, next: pending[0]?.id ?? null };
}

export async function setOnboardingStep(env: Env, step: unknown, status: unknown, by: string | null): Promise<{ ok: true; state: OnboardingState } | { ok: false; error: string }> {
  if (typeof step !== "string" || !ONBOARDING_STEPS.some((s) => s.id === step)) return { ok: false, error: `step must be one of: ${ONBOARDING_STEPS.map((s) => s.id).join(", ")}` };
  if (status !== "done" && status !== "skipped" && status !== "pending") return { ok: false, error: 'status must be "done", "skipped" or "pending"' };
  if (status === "pending") {
    await env.OFFICE_DB.prepare("DELETE FROM onboarding_progress WHERE step = ?").bind(step).run();
  } else {
    await env.OFFICE_DB.prepare("INSERT INTO onboarding_progress (step, status, updated_by) VALUES (?, ?, ?) ON CONFLICT(step) DO UPDATE SET status = excluded.status, updated_at = datetime('now'), updated_by = excluded.updated_by")
      .bind(step, status, by)
      .run();
  }
  return { ok: true, state: await onboardingState(env) };
}

// GET /onboarding: where the owner is. POST /onboarding/step {step, status}: mark one (idempotent: the same call twice is the same as once). Returns null for any other path.
export async function onboardingRoute(request: Request, env: Env, url: URL, by: string | null): Promise<Response | null> {
  if (url.pathname === "/onboarding" && request.method === "GET") return Response.json(await onboardingState(env));
  if (url.pathname === "/onboarding/step" && request.method === "POST") {
    let body: { step?: unknown; status?: unknown };
    try {
      body = (await request.json()) as { step?: unknown; status?: unknown };
    } catch {
      return Response.json({ error: "send JSON: {\"step\": \"customers\", \"status\": \"skipped\"}" }, { status: 400 });
    }
    const result = await setOnboardingStep(env, body?.step, body?.status, by);
    return result.ok ? Response.json(result.state) : Response.json({ error: result.error }, { status: 400 });
  }
  return null;
}
