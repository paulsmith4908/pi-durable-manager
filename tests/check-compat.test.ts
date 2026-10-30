// Tests for the STRICT service-compatibility gate (Block 3).
//
// The old label/comment claimed "package version + provider" were compared while
// the code only compared config/state/protocol/model, and `sameModel` permitted a
// missing model. This pins the corrected contract: package version, protocol,
// state, config, provider id, AND model are all validated strictly; a missing
// field is a mismatch. A same-protocol OLD package (e.g. 0.2.0) is REJECTED.

import { test } from "node:test";
import assert from "node:assert/strict";

import { serviceCompatCheck, type ServiceIdentity } from "../src/check.js";

const EXPECTED = {
  configPath: "/etc/pi/config.json",
  stateDir: "/var/pi/state",
  packageVersion: "0.7.0-beta.2",
  model: "modal-latest",
};

/** A fully-compatible identity. Tests mutate one field at a time. */
function compatible(): ServiceIdentity {
  return {
    configFile: "/etc/pi/config.json",
    stateDir: "/var/pi/state",
    protocolVersion: 1,
    packageVersion: "0.7.0-beta.2",
    providerId: "modal",
    model: "modal-latest",
  };
}

test("serviceCompatCheck: an identical identity is compatible", () => {
  const r = serviceCompatCheck(compatible(), EXPECTED);
  assert.equal(r.compatible, true, r.reasons.join("; "));
  assert.deepEqual(r.reasons, []);
});

test("serviceCompatCheck: a same-protocol OLD package (0.2.0) is REJECTED", () => {
  const status = { ...compatible(), packageVersion: "0.2.0" };
  const r = serviceCompatCheck(status, EXPECTED);
  assert.equal(r.compatible, false, "0.2.0 service must be rejected");
  assert.equal(r.sameProtocol, true, "protocol alone still matches");
  assert.equal(r.samePackageVersion, false);
  assert.match(r.reasons.join(" "), /package version 0\.2\.0 ≠ 0\.7\.0-beta\.2/);
});

test("serviceCompatCheck: a missing packageVersion is a mismatch (not 'unknown so fine')", () => {
  const status = compatible() as ServiceIdentity;
  delete (status as { packageVersion?: string }).packageVersion;
  const r = serviceCompatCheck(status, EXPECTED);
  assert.equal(r.compatible, false);
  assert.equal(r.samePackageVersion, false);
});

test("serviceCompatCheck: a missing model is a mismatch (old sameModel allowed it)", () => {
  const status = compatible() as ServiceIdentity;
  delete (status as { model?: string }).model;
  const r = serviceCompatCheck(status, EXPECTED);
  assert.equal(r.compatible, false);
  assert.equal(r.sameModel, false);
});

test("serviceCompatCheck: wrong protocol is rejected", () => {
  const r = serviceCompatCheck({ ...compatible(), protocolVersion: 2 }, EXPECTED);
  assert.equal(r.compatible, false);
  assert.equal(r.sameProtocol, false);
});

test("serviceCompatCheck: wrong provider id is rejected", () => {
  const r = serviceCompatCheck({ ...compatible(), providerId: "openai" }, EXPECTED);
  assert.equal(r.compatible, false);
  assert.equal(r.sameProvider, false);
});

test("serviceCompatCheck: a different state dir is rejected", () => {
  const r = serviceCompatCheck({ ...compatible(), stateDir: "/other/state" }, EXPECTED);
  assert.equal(r.compatible, false);
  assert.equal(r.sameState, false);
});

test("serviceCompatCheck: a different config file is rejected", () => {
  const r = serviceCompatCheck({ ...compatible(), configFile: "/other/config.json" }, EXPECTED);
  assert.equal(r.compatible, false);
  assert.equal(r.sameConfig, false);
});

test("serviceCompatCheck: null/undefined status is incompatible (read failure-ish)", () => {
  assert.equal(serviceCompatCheck(null, EXPECTED).compatible, false);
  assert.equal(serviceCompatCheck(undefined, EXPECTED).compatible, false);
});
