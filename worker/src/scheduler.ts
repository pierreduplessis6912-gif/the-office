// The Scheduler primitive — everything about time: task creation and
// completion (deterministic matching, the Execution Ladder), real
// scheduled dates (resolveScheduledDate, never an AI call for date math),
// the ember counts for Tasks/Scheduler. Also job-scope recording, since a
// job's lifecycle (measured -> scheduled -> priced) is genuinely scheduling
// territory.

import type { Env, WorkObservationExtraction } from "./types";


// Unguarded, deliberately — same reasoning already applied to
// characters and life events. Nothing here touches money or the
// outside world; a wrong measurement is a cheap, easily corrected
// mistake, not the category of consequence guard() exists for. Area
// is always computed here, in code, from raw dimensions — never asked
// of the model.
// Real feature 2026-07-11: scheduled_date_raw has always been a free
// phrase ("next Thursday", "in two weeks"), never resolved into a
// real, queryable date. Turning that phrase into an actual calendar
// date is the same class of problem as "the LLM must never do
// arithmetic" — the model's job stays extracting the phrase; this
// function does the actual date math, deterministically, verified
// directly in Node before ever touching production. Covers the real,
// common phrasings only (today/tomorrow/weekday names/"in N days or
// weeks"/day-of-month); anything genuinely unparseable stays honestly
// null rather than guessed at by an AI call.
export function resolveScheduledDate(rawPhrase: string | null, now: Date): string | null {
  if (!rawPhrase) return null;
  const phrase = rawPhrase.toLowerCase().trim();
  const pad = (n: number) => String(n).padStart(2, "0");
  const toIso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  if (phrase.includes("today")) return toIso(now);
  if (phrase.includes("tomorrow")) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return toIso(d);
  }

  const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  for (let i = 0; i < weekdays.length; i++) {
    if (phrase.includes(weekdays[i])) {
      const currentDay = now.getDay();
      let diff = (i - currentDay + 7) % 7;
      if (diff === 0) diff = 7; // "Thursday" said on a Thursday means the next one, not today
      const d = new Date(now);
      d.setDate(d.getDate() + diff);
      return toIso(d);
    }
  }

  const inDaysMatch = phrase.match(/in (\d+) days?/);
  if (inDaysMatch) {
    const d = new Date(now);
    d.setDate(d.getDate() + parseInt(inDaysMatch[1], 10));
    return toIso(d);
  }
  const inWeeksMatch = phrase.match(/in (\d+) weeks?/);
  if (inWeeksMatch) {
    const d = new Date(now);
    d.setDate(d.getDate() + parseInt(inWeeksMatch[1], 10) * 7);
    return toIso(d);
  }
  if (phrase.includes("next week")) {
    const d = new Date(now);
    d.setDate(d.getDate() + 7);
    return toIso(d);
  }

  const dayOfMonthMatch = phrase.match(/\b(\d{1,2})(st|nd|rd|th)?\b/);
  if (dayOfMonthMatch) {
    const day = parseInt(dayOfMonthMatch[1], 10);
    if (day >= 1 && day <= 31) {
      const year = now.getFullYear();
      let month = now.getMonth();
      let candidate = new Date(year, month, day);
      if (candidate < now) {
        month += 1;
        candidate = new Date(year, month, day);
      }
      return toIso(candidate);
    }
  }

  return null;
}

// The Worker's own clock is UTC; the business runs on SAST (UTC+2, no
// DST — safe as a fixed offset, unlike timezones that observe it).
// Without this, a message sent close to midnight SAST could resolve
// "today"/weekday math against the wrong UTC day.
export function nowInBusinessTimezone(): Date {
  return new Date(Date.now() + 2 * 60 * 60 * 1000);
}

// Real feature 2026-07-12 — the smallest real first domino toward
// team support: linking a job to who's actually assigned to do it,
// not just who it's for. installerId is an already-reconciled
// character (a real, non-billed person), resolved by the caller the
// same way customerId already is — this function just writes the
// link, no reconciliation logic duplicated here.
export async function recordWorkObservation(
  env: Env,
  customerId: number,
  observation: WorkObservationExtraction,
  sourceTranscript: string,
  installerId: number | null = null
): Promise<{ jobScopeId: number }> {
  const scheduledDate = resolveScheduledDate(observation.scheduled_date_raw, nowInBusinessTimezone());
  const inserted = await env.OFFICE_DB.prepare(
    "INSERT INTO job_scopes (customer_id, description, scheduled_date_raw, scheduled_date, installer_id, source_transcript) VALUES (?, ?, ?, ?, ?, ?) RETURNING id"
  )
    .bind(customerId, observation.job_description, observation.scheduled_date_raw, scheduledDate, installerId, sourceTranscript)
    .first<{ id: number }>();

  const jobScopeId = inserted!.id;

  // Maps a component's name back to its real D1 id, so a task naming
  // "Theatre 2" can be linked to the actual row just inserted for it.
  const componentIdByName = new Map<string, number>();

  for (const component of observation.components) {
    // Unit conversion — the one piece of arithmetic in this whole
    // step — always happens here, in code. The model's only job was
    // recognizing which unit was meant; multiplying by 1000 is never
    // something it does itself.
    const widthMm = component.width != null ? (component.unit === "m" ? component.width * 1000 : component.width) : null;
    const lengthMm =
      component.length != null ? (component.unit === "m" ? component.length * 1000 : component.length) : null;
    const areaSqm = widthMm != null && lengthMm != null ? (widthMm * lengthMm) / 1_000_000 : null;

    const insertedComponent = await env.OFFICE_DB.prepare(
      "INSERT INTO scope_components (job_scope_id, name, width_mm, length_mm, area_sqm) VALUES (?, ?, ?, ?, ?) RETURNING id"
    )
      .bind(jobScopeId, component.name, widthMm, lengthMm, areaSqm)
      .first<{ id: number }>();

    componentIdByName.set(component.name.toLowerCase(), insertedComponent!.id);
  }

  for (const task of observation.tasks) {
    const componentId = task.component_name ? componentIdByName.get(task.component_name.toLowerCase()) ?? null : null;
    await env.OFFICE_DB.prepare(
      "INSERT INTO scope_tasks (job_scope_id, description, component_id) VALUES (?, ?, ?)"
    )
      .bind(jobScopeId, task.description, componentId)
      .run();
  }

  return { jobScopeId };
}

// Small, deterministic cleanup — real polish item flagged since the
// first task test today: task descriptions stored the raw reminder
// phrasing verbatim ("remind me to get dog food"), making completion
// messages read oddly ("Marked done: remind me to get dog food"
// instead of "Marked done: get dog food"). Fixed rules, same input
// always produces the same output — text munging, not AI judgment.
// Verified directly in Node before deploying.
export function cleanTaskDescription(raw: string): string {
  let text = raw.trim();
  const prefixes = [
    /^remind me to\s+/i,
    /^please remind me to\s+/i,
    /^remember to\s+/i,
    /^don.t forget to\s+/i,
    /^dont forget to\s+/i,
  ];
  for (const p of prefixes) {
    if (p.test(text)) {
      text = text.replace(p, "");
      break;
    }
  }
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Real evidence 2026-07-10: a checkable personal errand needs a done
// state the narrative life-event log never had. Deliberately separate
// from pending_actions — guard()-confirmed items (payments, invoices,
// facts) already have their own done state (status/resolved_at); this
// is only ever for personal errands, never business/money records.
// Real feature 2026-07-11: optional customer_id/character_id — the
// actual prerequisite named by the ember-bar design for a future
// [Call] action ("call Sarah about invoice" needs Sarah's real phone
// number, which means a real link to her record, not a loose name in
// text). Same pattern as the captures FK fix — exactly one of the two
// is ever set, never both.
export async function createTask(
  env: Env,
  description: string,
  customerId: number | null = null,
  characterId: number | null = null
): Promise<void> {
  await env.OFFICE_DB.prepare("INSERT INTO tasks (description, done, customer_id, character_id) VALUES (?, 0, ?, ?)")
    .bind(cleanTaskDescription(description), customerId, characterId)
    .run();
}

export async function getOpenTasks(
  env: Env
): Promise<Array<{ id: number; description: string; customer_id: number | null; character_id: number | null }>> {
  const { results } = await env.OFFICE_DB.prepare(
    "SELECT id, description, customer_id, character_id FROM tasks WHERE done = 0 ORDER BY created_at DESC"
  ).all<{ id: number; description: string; customer_id: number | null; character_id: number | null }>();
  return results ?? [];
}

export async function completeTask(env: Env, id: number): Promise<void> {
  await env.OFFICE_DB.prepare("UPDATE tasks SET done = 1, completed_at = datetime('now') WHERE id = ?").bind(id).run();
}
// Real correction 2026-07-11: this used to hand the AI the list of
// open tasks and ask it to judge which one matched — that's AI doing
// matching, which is exactly the line drawn against. Rebuilt as pure
// deterministic logic, same "execution ladder" as everything else in
// this reasoning: register-of-one (only one open task exists, so
// there's nothing else it could mean), then real token-overlap
// matching, then — only if genuinely unresolvable — present the real
// candidates and let Peter decide. No AI call anywhere in this
// function. The only remaining AI-adjacent step is phrasing "did you
// mean X or Y," which is plain string joining downstream, not
// reasoning either.
//
// A small set of words carrying no matching signal on their own —
// excluded so "called them" doesn't spuriously overlap with "remind
// me to" in every task description.
export const TASK_MATCH_STOPWORDS = new Set([
  "the", "a", "an", "to", "them", "it", "that", "this", "my", "i", "on",
  "for", "of", "in", "and", "with", "about", "up", "me", "remind",
]);

// Crude, deterministic stemming — just enough to see "called" and
// "call" as the same token without any semantic reasoning. This is
// still an index, not a judgment: fixed rules, always the same
// output for the same input, fully inspectable.
export function stem(word: string): string {
  if (word.endsWith("ed") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("ing") && word.length > 5) return word.slice(0, -3);
  if (word.endsWith("s") && word.length > 3) return word.slice(0, -1);
  return word;
}

export function meaningfulTokens(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  return new Set(words.filter((w) => w.length > 2 && !TASK_MATCH_STOPWORDS.has(w)).map(stem));
}

export function resolveTaskCompletion(
  message: string,
  openTasks: Array<{ id: number; description: string }>
): { matched: { id: number; description: string } | null; candidates: Array<{ id: number; description: string }> } {
  if (openTasks.length === 0) return { matched: null, candidates: [] };
  // Only one thing it could possibly mean — no matching needed at all.
  if (openTasks.length === 1) return { matched: openTasks[0], candidates: [] };

  const messageTokens = meaningfulTokens(message);
  const directMatches = openTasks.filter((t) => {
    const taskTokens = meaningfulTokens(t.description);
    for (const tok of messageTokens) {
      if (taskTokens.has(tok)) return true;
    }
    return false;
  });

  if (directMatches.length === 1) return { matched: directMatches[0], candidates: [] };
  if (directMatches.length > 1) return { matched: null, candidates: directMatches };
  // No token overlap with ANY open task — genuinely unspecified.
  // Presenting every open task here is a defensible last resort
  // (asking is cheap), but only reached when there's truly zero
  // linguistic signal to narrow it, not when matching just missed.
  return { matched: null, candidates: openTasks };
}

export async function getCompletedToday(env: Env): Promise<string[]> {
  const pad = (n: number) => String(n).padStart(2, "0");
  const now = nowInBusinessTimezone();
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const { results: doneTasks } = await env.OFFICE_DB.prepare(
    "SELECT description FROM tasks WHERE done = 1 AND date(completed_at) = ?"
  )
    .bind(today)
    .all<{ description: string }>();

  const { results: confirmed } = await env.OFFICE_DB.prepare(
    "SELECT type, payload FROM pending_actions WHERE status = 'confirmed' AND date(resolved_at) = ?"
  )
    .bind(today)
    .all<{ type: string; payload: string }>();

  const taskFacts = doneTasks.map((t) => `Done: ${t.description}.`);
  const actionFacts = confirmed.map((a) => {
    try {
      const payload = JSON.parse(a.payload) as { customerName?: string; amount?: number };
      return `${a.type} confirmed${payload.customerName ? ` for ${payload.customerName}` : ""}${payload.amount ? ` (R${payload.amount})` : ""}.`;
    } catch {
      return `${a.type} confirmed.`;
    }
  });

  return [...taskFacts, ...actionFacts];
}

// Real feature 2026-07-11: "what's up today" needs to combine two
// real, already-built sources — job_scopes with a real scheduled_date
// falling on today, and currently open tasks (no due date exists on
// tasks yet; the full scheduling engine that would add one is
// deliberately pinned, not built — see OFFICE_CONSTITUTION.md). This
// stays the same "smallest honest version, computed live" pattern
// already used for the weekly briefing and the calendar query — no
// cron, no push, read fresh on request.
export async function getTodaysSchedule(env: Env): Promise<string[]> {
  const pad = (n: number) => String(n).padStart(2, "0");
  const now = nowInBusinessTimezone();
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

  const { results: scheduledJobs } = await env.OFFICE_DB.prepare(
    `SELECT js.description, c.name as customer_name FROM job_scopes js
     JOIN customers c ON c.id = js.customer_id
     WHERE js.scheduled_date = ?`
  )
    .bind(today)
    .all<{ description: string; customer_name: string }>();

  const openTasks = await getOpenTasks(env);

  const jobFacts = scheduledJobs.map((j) => `Scheduled today: ${j.description} for ${j.customer_name}.`);
  const taskFacts = openTasks.map((t) => `Still open: ${t.description}.`);

  return [...jobFacts, ...taskFacts];
}

// Real feature 2026-07-12 — the first real answer to "how's Sipho
// doing," honestly scoped to what's genuinely trackable today. Real,
// deliberately NOT the fuller vision (completion status, average
// gross margin per installer) — job_scopes has no completion tracking
// at all yet, and there's no direct link from a job to the quotation/
// invoice that priced it, so per-installer margin can't be computed
// without guessing. This reports only jobs assigned and their real
// scheduled dates — the honest first domino, not the destination.
export async function getInstallerActivity(env: Env, characterId: number): Promise<string[]> {
  const { results } = await env.OFFICE_DB.prepare(
    `SELECT js.description, js.scheduled_date, c.name as customer_name
     FROM job_scopes js JOIN customers c ON c.id = js.customer_id
     WHERE js.installer_id = ?
     ORDER BY js.scheduled_date ASC`
  )
    .bind(characterId)
    .all<{ description: string; scheduled_date: string | null; customer_name: string }>();

  if (results.length === 0) return ["No jobs assigned to this person yet."];

  const summary = `${results.length} job${results.length > 1 ? "s" : ""} assigned.`;
  const perJob = results.map(
    (r) => `${r.description} for ${r.customer_name}${r.scheduled_date ? ` (scheduled ${r.scheduled_date})` : " (no date scheduled yet)"}.`
  );
  return [summary, ...perJob];
}

// Real feature 2026-07-11 — the ember bar, scoped deliberately to only
// the departments with real data behind them today. No Weather
// (no external API exists anywhere in this project), no Call/
// Reschedule actions on tasks (tasks have no customer/character link
// or due date yet — both real, named gaps, not silently promised).
// Counts only, computed fresh on every response — this is what makes
// an ember feel "live": it updates the instant Peter's own words
// change something, not from a persistent connection pushing on its
// own. Per Principle 19, a zero here is the genuinely desired steady
// state, not an empty placeholder.
// Real feature 2026-07-12: expenses is its own bucket, not folded into
// finance — the two represent opposite directions of money (finance
// counts real receivables, money owed TO the business; expenses
// counts real spend, money paid OUT), matching the distinct
// Finance/Procurement buckets from the original ember design.
export async function getEmberCounts(
  env: Env
): Promise<{ tasks: number; scheduler: number; finance: number; expenses: number }> {
  const pad = (n: number) => String(n).padStart(2, "0");
  const now = nowInBusinessTimezone();
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

  const [tasksRow, schedulerRow, financeRow, expensesRow] = await Promise.all([
    env.OFFICE_DB.prepare("SELECT COUNT(*) as n FROM tasks WHERE done = 0").first<{ n: number }>(),
    env.OFFICE_DB.prepare("SELECT COUNT(*) as n FROM job_scopes WHERE scheduled_date = ?").bind(today).first<{ n: number }>(),
    env.OFFICE_DB.prepare(
      `SELECT COUNT(*) as n FROM (
         SELECT c.id, COALESCE(SUM(i.amount), 0) - COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.customer_id = c.id), 0) as balance
         FROM customers c JOIN invoices i ON i.customer_id = c.id
         GROUP BY c.id HAVING balance > 0
       )`
    ).first<{ n: number }>(),
    env.OFFICE_DB.prepare("SELECT COUNT(*) as n FROM expenses WHERE date(created_at) = ?").bind(today).first<{ n: number }>(),
  ]);

  return {
    tasks: tasksRow?.n ?? 0,
    scheduler: schedulerRow?.n ?? 0,
    finance: financeRow?.n ?? 0,
    expenses: expensesRow?.n ?? 0,
  };
}
