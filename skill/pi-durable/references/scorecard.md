# Delegation scorecard and Codex activity ledger

The Pi overview separates accepted scope from manager effort. It does not equate token volume,
lines changed, elapsed runtime, or assignment count with useful work. It makes no cost-saving claim.

## What the overview measures

- **Pi-only accepted scope:** Pi-only accepted points / all accepted points. Codex and mixed points
  remain visible. This is reported authorship of accepted scope, not the fraction of total labor.
- **Plan completion:** accepted points / planned points. Record weights before implementation.
- **Corrective steering:** recorded debugging guidance and revision guidance. Product decisions,
  unclassified worker answers and unclassified steering messages are separate.
- **Direct Codex work:** implementation and repair entries. Record these even when Pi writes the
  final patch using Codex's supplied implementation. Routine review is separate.
- **First-review acceptance:** completed milestones with an accepted Pi assignment and no revision
  requests / completed milestones with an accepted Pi assignment. A question-related cancellation
  is not a revision. It is an observed review rate, not proof of quality.
- **Trends:** last 20 accepted milestones in completion order, showing points, attribution,
  revisions, corrective steering, direct Codex work and first review. Compare similar scope sizes;
  a change in task difficulty or reporting coverage can change the numbers.
- **Codex active time:** optional measured active seconds on reported entries. Untimed entries
  remain unknown. The displayed partial sum is not total time, waiting time or billable time.

Historical assignment acceptance/revision/cancellation counts remain visible. No historical weights,
Codex token totals or minutes are invented. The ledger is partial: workflow answers, reviews and
steer/followup messages are automatically recorded after success; planning, direct edits and review
work outside those operations must be explicitly reported by the manager. A crash before an
operator operation reconciles may leave its ledger entry absent until that request is retried.
Low-level review/decision APIs do not automatically create workflow ledger entries.

## Manager workflow

Discover the exact installed descriptors with `service.capabilities`. Use the normal authenticated
local Pi client/CLI, not HTTP writes in the viewer. These methods create no worker or model request.
Use a stable requestId per logical entry and retry the same payload. Different payloads conflict.

1. After opening a workflow, plan a milestone before starting its work:

   ```json
   {"id":"WORKFLOW","milestoneId":"engine","title":"Playable engine","points":3,"requestId":"plan-engine"}
   ```

   Call `scorecard.plan`. Points are integers 1–100; use a consistent small scale such as 1/2/3/5.
   Weights and titles are immutable to prevent retrospective score inflation. Add genuinely new
   scope as new milestones; never add duplicate scope just to improve the score. Up to 100 per task.

2. Supply `milestoneId` on `workflow.submit`. Revisions and question/resume continuations inherit
   their parent's milestone automatically. A continuation cannot change it. Unmapped assignments
   remain explicitly unmeasured rather than being guessed from task text or roadmap checkboxes.

3. `workflow.answer` optionally accepts `activityCategory`: normally `product_decision`,
   `debugging_guidance` or `recovery`; absent means `question_unclassified`.
   `sessions.steer/followup` also accept this field; absent means `steering_unclassified`.
   Successful answers deduplicate by event; steering deduplicates by input request ID.
   `workflow.review` automatically records acceptance as `review`, revision as `revision_guidance`.
   Do not manually duplicate these records. Replays must preserve the original classification.

4. Report meaningful Codex work outside those automatic records with `scorecard.activity`:

   ```json
   {"id":"WORKFLOW","milestoneId":"engine","category":"repair","note":"Codex fixed collision handling; reviewed diff and reran tests.","requestId":"repair-collision"}
   ```

   Categories: planning, review, product_decision, debugging_guidance, implementation, repair,
   revision_guidance, question_unclassified, steering_unclassified, recovery.
   Optional `assignmentId` must belong to the workflow and agree with the milestone.
   Optional `activeSeconds` is a measured integer 0–86400, not a guessed duration. Omit when unknown.
   Use one entry per meaningful work unit, not one per tool call. State direct contributions candidly.
   Retrospective reports must use `retrospective:true` and reference the supporting evidence in the
   note; the entry timestamp is recording time, not an invented original time.

5. After independent review, call `scorecard.accept`:

   ```json
   {"id":"WORKFLOW","milestoneId":"engine","owner":"pi","assignmentId":"ACCEPTED_ASSIGNMENT","note":"Reviewed implementation and tests","evidence":"Evidence SHA-256 and test artifact path","requestId":"accept-engine"}
   ```

   `owner` is pi, codex or mixed. Pi/mixed requires an accepted assignment linked to the milestone;
   all milestone assignments must be settled/reviewed. Evidence is the manager's reference, not
   automatically verified by this accounting method. `workflow.review` still performs the evidence
   freshness gate. Recording a milestone never accepts a worker, releases a lease or finishes a task.
   If Codex wrote/repaired code, use mixed. A later direct-work disclosure automatically changes
   the displayed Pi-only attribution to mixed while preserving the original acceptance record.
   Codex-only completion requires a manager evidence note but no Pi assignment.

6. `scorecard.read {id}` returns totals, all planned milestones, last 20 completion trend rows and
   latest 30 ledger entries. `scorecard.ledger {id,before?,limit?}` pages the entire durable ledger
   newest first; use returned `nextBefore` until null. The maximum page is 50; capacity is 10,000
   entries per workflow. The overview is read-only and keeps worker status usable if scorecard
   reads fail. Durable records survive service restarts and workflow completion.

Pi session tokens are available separately via `sessions.usage`; deduplicate session IDs if summing.
Neither cross-model token ratios nor provider cost metadata are an offload/cost-savings metric.
