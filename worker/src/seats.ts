// Seats: how many people a business may have (billing). A Single user plan is one person; a Team or Enterprise plan is the seats paid for; a trial, an operator's business, a plan with no seats recorded and anything unknown has NO limit.
// The check counts the people who are really on the team (active members) plus the invitations that are really waiting (each will use a seat when accepted), and only a plan with a seat limit ever refuses anyone. It only READS, and like every
// limit in this system it FAILS OPEN: if the plan or the members cannot be read the owner is not stopped, because a billing fault must never stop a business working. (Downgrading below the people already there never removes anyone: it only
// refuses to add more.) Pinned in tools/plans.test.js.
import { listInvitationsFor, normaliseEmail } from "./directory";
import type { Env } from "./types";

export interface SeatCap { cap: number | null; plan: string | null; label: string | null; seatBased: boolean }
const unlimited: SeatCap = { cap: null, plan: null, label: null, seatBased: false };
const sharedOf = (env: Env): Env => ({ ...env, OFFICE_DB: (env.SHARED_DB ?? env.OFFICE_DB) as D1Database });

export async function seatCap(env: Env): Promise<SeatCap> {
  try {
    const row = await sharedOf(env).OFFICE_DB.prepare("SELECT b.plan AS plan, b.seats AS seats, p.label AS label, p.per_seat AS per_seat, p.max_seats AS max_seats FROM businesses b LEFT JOIN plans p ON p.name = b.plan WHERE b.id = ?")
      .bind(env.BUSINESS_ID ?? "")
      .first<{ plan: string; seats: number | null; label: string | null; per_seat: number | null; max_seats: number | null }>();
    if (!row) return unlimited;
    const seatBased = row.per_seat === 1;
    const cap = seatBased ? (typeof row.seats === "number" && row.seats >= 1 ? row.seats : null) : typeof row.max_seats === "number" && row.max_seats >= 1 ? row.max_seats : null;
    return { cap, plan: row.plan, label: row.label ?? row.plan, seatBased };
  } catch {
    return unlimited;   // the plan could not be read (an older shared layer, any error): no limit
  }
}

export type SeatCheck = { ok: true } | { ok: false; status: 402; error: string };
export async function checkSeat(env: Env, options: { adding: number; ignoreInvitationFor?: string }): Promise<SeatCheck> {
  if (options.adding <= 0) return { ok: true };
  try {
    const seats = await seatCap(env);
    if (seats.cap === null) return { ok: true };
    const active = Number((await env.OFFICE_DB.prepare("SELECT COUNT(*) AS n FROM memberships WHERE status = 'active'").first<{ n: number }>())?.n ?? 0);
    const ignore = options.ignoreInvitationFor ? normaliseEmail(options.ignoreInvitationFor) : null;
    const waiting = (await listInvitationsFor(sharedOf(env), env.BUSINESS_ID ?? "")).filter((i) => normaliseEmail(i.email) !== ignore).length;
    if (active + waiting + options.adding <= seats.cap) return { ok: true };
    const label = seats.label ?? "current";
    return {
      ok: false,
      status: 402,
      error: seats.cap === 1 ? `Your ${label} plan is for one person. Move to the Team plan to add people.` : `Your ${label} plan has ${seats.cap} seats and all are in use (people on the team and invitations waiting). Add a seat to add more people.`,
    };
  } catch {
    return { ok: true };
  }
}
