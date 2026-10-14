/** Increment 2: the phone's delegation state, derived from THREE independent facts that are never inferred from one another:
 *  1. saved assignment state (what the authority recorded for this Task),
 *  2. present read availability (history discovery complete? the saved result currently verified?),
 *  3. permission for NEW work (current admission, pilot window, Task unchanged).
 * Pure and side-effect free: it only decides what to show and which mutations the UI may offer. The Framework's admission and
 * claim guards remain the actual execution boundary; this is the console's safety policy. A timeout is "unconfirmed", never
 * "absent", "rejected" or "not started"; a generic 503 is not a pilot-specific refusal. */

/** Fixed public reasons (never raw exception text). */
export const DELEGATION_REASONS = {
  host_not_admitted: 'No admitted agent can take new work for this Task right now.',
  pilot_window_ended: 'The window for new work on this pilot has ended. Saved assignments and results stay available.',
  task_changed: 'The Task changed after these instructions were saved. New work needs its own approval.',
  history_incomplete: 'Saved assignments are still being checked. New work waits until that check is complete.',
  unresolved_assignment: 'An earlier assignment for this Task is not finished. New work waits until it is.',
  publisher_model_not_admitted: 'The Report library is not ready to accept new results. Saved results stay available.',
  host_unavailable: 'The task host could not be reached. Nothing new was started.',
  pilot_invocation_used: 'This pilot’s one run has been used. Saved assignments and results stay available.',
  pilot_plan_pinned: 'This pilot’s plan is fixed by its operator. It appears here once saved and cannot be written or edited on this page.',
  pilot_plan_differs: 'This saved plan is not the pilot’s fixed plan, so it cannot be approved here.',
} as const;
export type DelegationReason = keyof typeof DELEGATION_REASONS;

export type WorkerStatus = 'EXECUTION_RUNNING' | 'EXECUTION_REJECTED' | 'EXECUTION_UNCERTAIN' | 'REPORT_PENDING' | 'REPORT_PUBLISHED';
export type Readback = 'verified' | 'unavailable' | 'changed';

export type DelegationFacts = {
  /** Fact 2a: discovery of saved assignments for this Task. Anything but 'complete' forbids new prepare/start. */
  history: 'loading' | 'failed' | 'incomplete' | 'complete';
  /** Fact 3: permission for new work (separate request; its failure never hides history). */
  newWork: { admitted: true } | { admitted: false; reason: DelegationReason | null };
  pilotExpired: boolean;
  /** The Task changed after the selected assignment's instructions were saved. */
  taskChanged: boolean;
  /** Pinned pilot plan (Framework pilot signals): 'none' = no pinned plan known; otherwise whether the selected saved plan is it.
   * A pinned plan cannot be written or edited in the console; only that exact plan may be approved. */
  planPinned?: 'none' | 'pinned' | 'matches' | 'differs';
  /** Other assignments for this Task that are not terminal (blockingOperationIds from discovery). */
  blockingAssignments: number;
  /** Fact 1: the selected assignment, if any. */
  assignment:
    | null
    | { kind: 'saved-unapproved' }
    | { kind: 'request-unconfirmed'; request: 'create' | 'approval' | 'start' }
    | { kind: 'approved'; claim: 'unknown' | 'never-claimed' }
    | { kind: 'worker'; status: Exclude<WorkerStatus, 'REPORT_PUBLISHED'> }
    | { kind: 'result'; readback: Readback; verifiedAt: string | null };
};

export type DelegationStateId =
  | 'checking' | 'no-plan' | 'new-work-unavailable' | 'approve-and-start' | 'saved-plan' | 'request-unconfirmed' | 'approval-saved'
  | 'approved-not-started' | 'agent-working' | 'work-not-completed' | 'report-pending' | 'report-ready' | 'saved-result-unverified'
  | 'saved-result-changed';

export type PrimaryAction = 'check-status' | 'save-plan' | 'approve-and-start' | 'continue-approved' | 'open-report' | null;

export type DelegationView = {
  /** Plan editing (revise) is allowed: never for a pinned pilot plan. */
  editable: boolean;
  state: DelegationStateId;
  title: string;
  primary: PrimaryAction;
  /** The ONLY mutations the UI may offer in this state. Status reads are always allowed and never mutate. */
  mutations: { create: boolean; approveAndStart: boolean; continueApproved: boolean };
  /** Polling cadence while this state lasts (ms), or null = no automatic polling (Check status only). */
  pollMs: number | null;
  /** Separate new-work message: never replaces the saved assignment/result. */
  newWork: { available: boolean; reason: DelegationReason | null; message: string | null };
  /** Saved assignment/result shown although the current check is incomplete or verification is unavailable. */
  stale: boolean;
};

const NONE = { create: false, approveAndStart: false, continueApproved: false };

function newWorkOf(f: DelegationFacts): DelegationView['newWork'] {
  const reason: DelegationReason | null =
    f.history !== 'complete' ? 'history_incomplete'
    : f.pilotExpired ? 'pilot_window_ended'
    : !f.newWork.admitted ? (f.newWork.reason ?? 'host_not_admitted')
    : f.blockingAssignments > 0 ? 'unresolved_assignment'
    : null;
  return { available: reason === null, reason, message: reason ? DELEGATION_REASONS[reason] : null };
}

export function deriveDelegationView(f: DelegationFacts): DelegationView {
  const newWork = newWorkOf(f);
  const may = newWork.available; // every mutation needs complete history + current admission + open window + no blocker
  const a = f.assignment;
  const pinned = (f.planPinned ?? 'none') !== 'none';
  const v = (state: DelegationStateId, title: string, primary: PrimaryAction, mutations = NONE, pollMs: number | null = null, stale = false, reason?: DelegationReason): DelegationView =>
    ({ state, title, primary, mutations, pollMs, stale, editable: !pinned && state === 'approve-and-start',
      newWork: reason && newWork.available ? { available: false, reason, message: DELEGATION_REASONS[reason] } : newWork });

  if (a === null) {
    if (f.history !== 'complete') return v('checking', f.history === 'failed' ? 'Saved assignments could not be read' : 'Checking saved assignments', 'check-status');
    if (pinned && may) return v('new-work-unavailable', 'Waiting for the pilot’s fixed plan', 'check-status', NONE, null, false, 'pilot_plan_pinned');
    return may ? v('no-plan', 'Write the instructions and save the plan for review', 'save-plan', { ...NONE, create: true })
      : v('new-work-unavailable', 'New work unavailable', null);
  }
  // From here a saved assignment exists: it is always shown, even when history is incomplete (marked stale).
  const partial = f.history !== 'complete';
  switch (a.kind) {
    case 'saved-unapproved':
      if (f.taskChanged) return v('saved-plan', 'Saved instructions — the Task has changed', 'check-status', NONE, null, partial);
      if (f.planPinned === 'differs') return v('saved-plan', 'Saved plan', 'check-status', NONE, null, partial, 'pilot_plan_differs');
      return may ? v('approve-and-start', 'Review the full plan, then approve and start', 'approve-and-start', { ...NONE, approveAndStart: true })
        : v('saved-plan', 'Saved plan', 'check-status', NONE, null, partial);
    case 'request-unconfirmed':
      // Read only: no automatic resend, no replacement assignment.
      return v('request-unconfirmed', 'Request not confirmed', 'check-status', NONE, 5000, partial);
    case 'approved':
      // Only explicit server evidence of "never claimed" plus current admission permits the one deliberate continuation.
      if (a.claim === 'never-claimed' && may && !f.taskChanged)
        return v('approved-not-started', 'Approved, not started', 'continue-approved', { ...NONE, continueApproved: true });
      return v('approval-saved', 'Approval saved', 'check-status', NONE, 5000, partial);
    case 'worker':
      if (a.status === 'EXECUTION_RUNNING') return v('agent-working', 'Agent working', 'check-status', NONE, 5000, partial);
      if (a.status === 'REPORT_PENDING') return v('report-pending', 'Output retained; Report not yet confirmed', 'check-status', NONE, 15000, partial);
      // Rejected or uncertain (consumed pilot): no Try again, no new round, no model-running recovery.
      return v('work-not-completed', 'Work not completed', 'check-status', NONE, null, partial);
    case 'result':
      // Owner decision (Oct 14): a verified Report may be followed by NEW work ("Revise or run again" → a new proposal round with
      // the prior Report as context). Only under every new-work rule: complete history, admitted, window open, no other
      // unresolved assignment; a pinned/consumed pilot stays single-run (newWork says why). Never a rerun of this assignment.
      if (a.readback === 'verified') return v('report-ready', 'Report ready', 'open-report', { ...NONE, create: may && !pinned }, null, partial, may && pinned ? 'pilot_plan_pinned' : undefined);
      if (a.readback === 'changed') return v('saved-result-changed', 'Saved result — the Report no longer matches it', 'check-status', NONE, null, true);
      return v('saved-result-unverified', 'Saved result; current verification unavailable', 'check-status', NONE, null, true);
  }
}
