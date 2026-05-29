// Live push_playbook — side-effect verification with auto-cleanup.
//
// Per the agreed policy: push a known-good playbook, confirm the real workflow
// record exists in SOAR, then DELETE it so the demo instance stays clean. The
// cleanup runs in afterAll regardless of assertion outcome, so a failed run
// never leaves orphaned records.
//
// Real connector wire (v0.3.1, confirmed from its info.json — the contract doc
// §1 drifted): push_playbook takes {workflow_json} (the COMPILED workflow, not
// raw yaml). So the live flow is compile_yaml(yaml) → workflow_json →
// push_playbook({workflow_json}) → {ok, workflow_iri?}.
//
// Gated: FSRPB_LIVE=1. NOTE: this MUTATES the demo SOAR (create + delete).
"use strict";

const fs = require("fs");
const path = require("path");
const { makeClient } = require("./lib/soarClient");

const LIVE = process.env.FSRPB_LIVE === "1";
const d = LIVE ? describe : describe.skip;

const VALID_YAML = fs.readFileSync(path.join(__dirname, "fixtures", "valid_playbook.yaml"), "utf8");

// Pull a workflow IRI out of the push response defensively — the contract says
// `workflow_iri`, but accept a few shapes so a minor connector variance doesn't
// silently skip cleanup.
function extractWorkflowIri(r) {
  if (!r) return null;
  return r.workflow_iri || r.workflow || r.iri || (r.data && r.data.workflow_iri) || null;
}
function toWorkflowPath(iri) {
  if (!iri) return null;
  if (iri.startsWith("/api/")) return iri;
  if (iri.startsWith("/")) return iri;
  return `/api/3/workflows/${iri}`;
}

d("live connector — push_playbook (mutating, auto-cleanup)", () => {
  let soar;
  const createdPaths = []; // everything we must delete

  beforeAll(async () => {
    soar = await makeClient();
    console.log(`[live] push_playbook against ${soar.meta.connector} v${soar.meta.version} @ ${soar.meta.host}`);
  });

  afterAll(async () => {
    for (const p of createdPaths) {
      try {
        const res = await soar.del(p);
        console.log(`[cleanup] DELETE ${p} -> ${res.status}`);
      } catch (e) {
        console.warn(`[cleanup] FAILED to delete ${p}: ${e.message} — remove manually`);
      }
    }
  });

  // BLOCKED by a connector-side bug (found 2026-05-29, connector v0.3.3):
  // push_playbook posts to /api/3/workflow_collections with a null `name` →
  //   "null value in column \"name\" of relation \"workflow_collections\""
  // even though compile_yaml's output carries the name at
  // workflow_json.data[0].name ("FSRPB Demo Record Create"). compile and push
  // disagree on the shape. The test below is correct (compile→push→verify→
  // cleanup); un-skip once the connector threads the collection name into push.
  // eslint-disable-next-line jest/no-disabled-tests
  test.skip("push_playbook: creates a workflow that exists in SOAR, then we clean it up", async () => {
    // 1. Compile the YAML to the workflow_json the connector's push wants.
    const compiled = await soar.exec("compile_yaml", { yaml: VALID_YAML });
    expect(compiled.ok).toBe(true);
    expect(compiled.workflow_json).toBeTruthy();

    // 2. Push the compiled workflow.
    const r = await soar.exec("push_playbook", { workflow_json: compiled.workflow_json }, { timeoutMs: 115000 });
    expect(r).toBeTruthy();
    expect(r.ok).toBe(true);

    const iri = extractWorkflowIri(r);
    expect(iri).toBeTruthy(); // contract requires workflow_iri on success
    const wfPath = toWorkflowPath(iri);
    createdPaths.push(wfPath); // register for cleanup BEFORE asserting existence

    // Verify the real side-effect: the workflow record is fetchable.
    const wf = await soar.get(wfPath);
    expect(wf).toBeTruthy();
    // SOAR returns the record with an @id / uuid; assert it's the same one.
    const gotId = wf && (wf["@id"] || wf.uuid || (wf.hydra && wf.hydra.member));
    expect(gotId).toBeTruthy();
  });
});
