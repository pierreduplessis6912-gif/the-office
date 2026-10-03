// Phase 1 of the processOneExtraction rewrite (see PROCESS_ONE_EXTRACTION_REWRITE.md): the explicit
// contract the function never had. NOTHING CALLS THIS YET. It is scaffolding alongside the live
// function, which is not edited; it exists so that Phase 2 (shadow mode: run old and new on the same
// input and compare) has something precise to compare.
//
// Everything here is grounded in what the live function actually does, measured on the real code
// (2026-10-03): it returns from 10 places (9 early, 1 final) through one 9-field shape, and the
// "pending" fields obey strict rules at every one of those returns (below). The adapter is lossless
// over that real domain and refuses, loudly, anything outside it, so a drift in the real function
// shows up as an error instead of a plausible wrong answer.
import type { Extraction } from "../types";

export type Intent = Extraction["intent"];

export interface ResolvedEntity {
  id: number;
  name: string;
  matched: boolean;
}
export interface PendingCandidate {
  id: number;
  name: string;
}
export interface PendingChange {
  field: string;
  oldValue: string | null;
  newValue: string | null;
}

// The shape processOneExtraction returns today, named but not changed. A test asserts that these nine
// fields are exactly the live function's return type, so this cannot quietly drift from it.
export interface LegacyProcessResult {
  customer: ResolvedEntity | null;
  character: ResolvedEntity | null;
  pendingActionId: number | null;
  factPendingActionId: number | null;
  message: string;
  jobScopeIdForProjectResolution: number | null;
  pendingCandidates: PendingCandidate[] | null;
  pendingActionType: string | null;
  pendingChanges: PendingChange[] | null;
}

// A confirmation the person is being asked for. The id and the type always travel together; candidates
// exist only for a genuine multi-candidate ambiguous_person hold and changes only for a
// job_scope_amendment hold (checked at every return site of the real function).
export interface HeldAction {
  id: number;
  type: string;
  candidates: PendingCandidate[] | null;
  changes: PendingChange[] | null;
}

// Something the call actually did, other than ask a question. One call can both hold an action and
// record something (an invoice held while a job scope is recorded alongside it), which is why the
// outcome is a held action plus a list of effects and not a single one-of-N value. Phase 1 can only
// evidence the job scope; Phase 2 adds a kind per recording the real handlers perform.
export type RecordedEffect = { kind: "job_scope"; id: number };

export interface ProcessingResult {
  customer: ResolvedEntity | null;
  character: ResolvedEntity | null;
  held: HeldAction | null;
  // The separate confirmation for a fact note (customer or character fact), when there is one.
  factHeldId: number | null;
  recorded: RecordedEffect[];
  message: string;
}

// Every way a legacy result can break the rules the real function obeys. Empty means well-formed.
export function legacyResultIssues(r: LegacyProcessResult): string[] {
  const issues: string[] = [];
  const hasId = r.pendingActionId !== null;
  if (hasId && r.pendingActionType === null) issues.push("pendingActionId is set but pendingActionType is null");
  if (!hasId && r.pendingActionType !== null) issues.push("pendingActionType is set but pendingActionId is null");
  if (!hasId && r.pendingCandidates !== null) issues.push("pendingCandidates is set but pendingActionId is null");
  if (!hasId && r.pendingChanges !== null) issues.push("pendingChanges is set but pendingActionId is null");
  if (r.pendingCandidates !== null && r.pendingActionType !== "ambiguous_person") {
    issues.push("pendingCandidates is only ever set for an ambiguous_person hold");
  }
  if (r.pendingChanges !== null && r.pendingActionType !== "job_scope_amendment") {
    issues.push("pendingChanges is only ever set for a job_scope_amendment hold");
  }
  return issues;
}

export class MalformedLegacyResult extends Error {
  constructor(public readonly issues: string[]) {
    super(`legacy processOneExtraction result breaks its own rules: ${issues.join("; ")}`);
    this.name = "MalformedLegacyResult";
  }
}

export function toProcessingResult(r: LegacyProcessResult): ProcessingResult {
  const issues = legacyResultIssues(r);
  if (issues.length > 0) throw new MalformedLegacyResult(issues);
  return {
    customer: r.customer,
    character: r.character,
    held:
      r.pendingActionId !== null
        ? { id: r.pendingActionId, type: r.pendingActionType as string, candidates: r.pendingCandidates, changes: r.pendingChanges }
        : null,
    factHeldId: r.factPendingActionId,
    recorded: r.jobScopeIdForProjectResolution !== null ? [{ kind: "job_scope", id: r.jobScopeIdForProjectResolution }] : [],
    message: r.message,
  };
}

// The other direction, so a result produced by new code can be compared with, or served as, the old shape.
export function toLegacyResult(r: ProcessingResult): LegacyProcessResult {
  const jobScope = r.recorded.find((e) => e.kind === "job_scope");
  return {
    customer: r.customer,
    character: r.character,
    pendingActionId: r.held ? r.held.id : null,
    factPendingActionId: r.factHeldId,
    message: r.message,
    jobScopeIdForProjectResolution: jobScope ? jobScope.id : null,
    pendingCandidates: r.held ? r.held.candidates : null,
    pendingActionType: r.held ? r.held.type : null,
    pendingChanges: r.held ? r.held.changes : null,
  };
}
