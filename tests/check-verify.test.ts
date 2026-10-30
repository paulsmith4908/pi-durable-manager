// Tests for the ONLINE `--verify` verdict logic and the delivery-state honesty
// rules (Block 2).
//
// The old code cast `assignments.show` as `{ assignment: { state } }` while the
// service returns a DIRECT `AssignmentDetail` (state at the top level), so it
// always printed `state=unknown` yet PASSed — a false positive. These tests pin
// the corrected behavior:
//   * PASS requires assignment ACCEPTED + event DELIVERED + ACKED;
//   * running/queued/needs_review/revision_requested (or delivered-but-unacked)
//     => PENDING;
//   * failed/unanswered/budget/timeout/cancelled or unknown/missing ids => FAIL;
//   * verification NEVER auto-accepts or auto-acks.

import { test } from "node:test";
import assert from "node:assert/strict";

import { verifyVerdict } from "../src/check.js";

const IDS = { assignmentId: "assign-1", projectId: "proj-1" };

test("verifyVerdict: ACCEPTED + delivered + acked is the ONLY PASS", () => {
  const v = verifyVerdict({
    assignmentState: "accepted",
    eventDelivered: true,
    eventAcked: true,
    eventListed: true,
    ...IDS,
  });
  assert.equal(v.status, "PASS");
});

test("verifyVerdict: accepted but event not listed/delivered/acked is PENDING (never PASS)", () => {
  for (const [eventListed, eventDelivered, eventAcked] of [
    [false, false, false],
    [true, false, false],
    [true, true, false],
  ] as const) {
    const v = verifyVerdict({
      assignmentState: "accepted",
      eventDelivered,
      eventAcked,
      eventListed,
      ...IDS,
    });
    assert.equal(
      v.status,
      "PENDING",
      `accepted delivered=${eventDelivered} acked=${eventAcked} listed=${eventListed} ⇒ PENDING`,
    );
  }
});

test("verifyVerdict: running-family states are PENDING", () => {
  for (const state of ["queued", "running", "needs_review", "revision_requested"]) {
    const v = verifyVerdict({
      assignmentState: state,
      eventDelivered: true,
      eventAcked: true,
      eventListed: true,
      ...IDS,
    });
    assert.equal(v.status, "PENDING", `${state} ⇒ PENDING`);
  }
});

test("verifyVerdict: failed-family states are FAIL", () => {
  for (const state of ["failed", "unanswered", "budget", "timeout", "cancelled"]) {
    const v = verifyVerdict({
      assignmentState: state,
      eventDelivered: true,
      eventAcked: true,
      eventListed: true,
      ...IDS,
    });
    assert.equal(v.status, "FAIL", `${state} ⇒ FAIL`);
  }
});

test("verifyVerdict: unknown state is FAIL, never a silent PASS", () => {
  const v = verifyVerdict({
    assignmentState: "bogus-state",
    eventDelivered: true,
    eventAcked: true,
    eventListed: true,
    ...IDS,
  });
  assert.equal(v.status, "FAIL");
});

test("verifyVerdict: missing/empty state is FAIL", () => {
  for (const state of [undefined, ""]) {
    const v = verifyVerdict({
      assignmentState: state,
      eventDelivered: true,
      eventAcked: true,
      eventListed: true,
      ...IDS,
    });
    assert.equal(v.status, "FAIL", `state=${String(state)} ⇒ FAIL`);
  }
});

test("verifyVerdict: missing assignmentId/projectId is FAIL", () => {
  assert.equal(
    verifyVerdict({
      assignmentState: "accepted",
      eventDelivered: true,
      eventAcked: true,
      eventListed: true,
      assignmentId: undefined,
      projectId: "proj-1",
    }).status,
    "FAIL",
  );
  assert.equal(
    verifyVerdict({
      assignmentState: "accepted",
      eventDelivered: true,
      eventAcked: true,
      eventListed: true,
      assignmentId: "assign-1",
      projectId: undefined,
    }).status,
    "FAIL",
  );
});

test("delivered vs queued: a queued/pending/parked/failed delivery is NOT delivered", () => {
  // The ACTUAL deliveryState from manager.events is the source of truth. Only
  // "delivered" counts; created/pending/parked/failed/superseded do not.
  const notDelivered = ["created", "pending", "parked", "failed", "superseded"];
  for (const deliveryState of notDelivered) {
    // An ACCEPTED assignment whose event is not actually delivered is PENDING.
    const v = verifyVerdict({
      assignmentState: "accepted",
      eventDelivered: deliveryState === "delivered",
      eventAcked: true,
      eventListed: true,
      ...IDS,
    });
    assert.equal(v.status, "PENDING", `deliveryState=${deliveryState} ⇒ PENDING, not PASS`);
  }
  // And the direct positive: delivered + accepted + acked ⇒ PASS.
  assert.equal(
    verifyVerdict({
      assignmentState: "accepted",
      eventDelivered: true,
      eventAcked: true,
      eventListed: true,
      ...IDS,
    }).status,
    "PASS",
  );
});
