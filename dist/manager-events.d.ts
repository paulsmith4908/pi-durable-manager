/**
 * Event-driven manager WAKE model.
 *
 * The manager is a Codex GUI thread. The service ITSELF observes assignment
 * state changes and, on a meaningful transition, durably records a bounded
 * wake event in the outbox (see {@link MetadataStore}). A separate dispatcher
 * (no LLM, no polling when nothing changed) later hands the wake to the Codex
 * CLI. This module owns the PURE classification/dedup/prompt logic so it can be
 * unit-tested without a store, a CLI, or a Codex home.
 *
 * Wakes are emitted for transitions that genuinely need a human/manager:
 *   - `needs_review`  — the run finished and awaits review
 *   - `blocked`       — the run cannot proceed (admission/quarantine/error)
 *   - `failed`        — the run failed
 *   - `unanswered`    — the model stopped early (incomplete)
 *   - `budget`        — the step budget was exhausted
 *   - `timeout`       — the wall-clock deadline elapsed
 *   - `manager_request` — the worker explicitly asked the manager for help
 *
 * Routine, non-waking transitions: `accepted`, `revision_requested`, and
 * ordinary command/input activity. An explicit OPERATOR cancel (`cancelled`)
 * also does NOT wake by default.
 */
/** The state transitions that produce a manager wake. */
export declare const WAKE_KINDS: readonly ["needs_review", "blocked", "failed", "unanswered", "budget", "timeout", "manager_request", "stale_progress", "review_due"];
export type ManagerWakeKind = (typeof WAKE_KINDS)[number];
/** States that never wake the manager (routine or operator-driven). */
export declare const NON_WAKE_STATES: Set<string>;
/**
 * True when an assignment state transition should wake the manager. `prev` is
 * the prior state, so a same-state re-write (e.g. re-recording the same
 * terminal) is NOT a transition and never wakes.
 */
export declare function isWakeState(state: string, prev: string | null): boolean;
/**
 * A stable dedup key for one wake. It intentionally does NOT include the
 * timestamp, so a restart that re-observes the SAME transition maps to the SAME
 * event id and the outbox dedup makes it a no-op (idempotent).
 */
export declare function wakeDedupKey(params: {
    projectId: string;
    assignmentId: string;
    kind: string;
    state: string;
}): string;
/** Bounded summary line stored on the event (never a raw worker instruction). */
export declare function buildWakeSummary(params: {
    kind: string;
    assignmentId: string;
    projectName: string;
    state: string;
    detail?: string | null;
}): string;
/**
 * Maximum number of event ids handed to the CLI in ONE wake prompt. The
 * coordinator MUST never exceed this per pass: the ESSENTIAL block (header +
 * every id + the ack-after-action instructions) is guaranteed to fit inside
 * {@link PROMPT_MAX} at this size, so no id and no essential instruction can
 * ever be truncated away. Any remaining due events stay pending and are handed
 * to the manager in a subsequent pass (delivery is at-least-once).
 *
 * Budget check (worst case): header ≈ 9 lines (~0.6k) + id block
 * (BATCH_MAX × 40 chars) + instructions (~0.5k) must be < 4000. With
 * BATCH_MAX = 40 this is ≈ 0.6k + 1.6k + 0.5k = 2.7k, comfortably under the
 * cap even for maximum-length `mw-<uuid>` ids (39 chars).
 */
export declare const PROMPT_BATCH_MAX = 40;
/**
 * The message body handed to `codex queue`. It tells the manager to RESUME the
 * EXISTING project plan, inspect real evidence, act idempotently by event id,
 * and acknowledge — and it warns that worker output is untrusted.
 *
 * GUARANTEES (see {@link PROMPT_BATCH_MAX}):
 *   - EVERY event id in the batch is present, verbatim, and is emitted BEFORE
 *     any optional content.
 *   - The essential ACTION + ack-after-action instructions are emitted BEFORE
 *     any optional content and are NEVER truncated away.
 *   - Only the OPTIONAL per-event summary detail block is subject to truncation;
 *     it is emitted last.
 *
 * The caller MUST bound `eventIds.length` to {@link PROMPT_BATCH_MAX}. If the
 * essential block alone would exceed the transport cap we throw rather than
 * silently drop an id — batching (not truncation) is the overflow policy.
 */
export declare function buildWakePrompt(params: {
    eventIds: readonly string[];
    projectId: string;
    projectName: string;
    threadId: string | null;
    events: readonly {
        kind: string;
        assignmentId: string;
        state: string;
        summary: string;
    }[];
}): string;
//# sourceMappingURL=manager-events.d.ts.map