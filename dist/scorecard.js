/** Manager-owned accounting. Counts are observations, never inferred productivity. */
import { StoreError } from './store.js';
export const CATEGORIES = ['planning', 'review', 'product_decision', 'debugging_guidance', 'implementation', 'repair', 'revision_guidance', 'question_unclassified', 'steering_unclassified', 'recovery'];
const key = (id) => `workflow-scorecard:${id}`;
const data = (s, id) => s.getControl(key(id)) ?? { milestones: [], links: {}, entries: [] };
const save = (s, id, d) => s.setWorkflowControl(key(id), d);
function text(p, k, max = 1200) {
    if (typeof p[k] !== 'string' || !p[k].trim() || p[k].length > max)
        throw new StoreError('invalid_params', `Expected bounded ${k}.`);
    return p[k];
}
function task(s, id) {
    const t = s.getControl(`workflow:${id}`);
    if (!t)
        throw new StoreError('not_found', 'Unknown workflow.');
    return t;
}
function rows(s, t) {
    return s.listAssignments(t.projectId).filter(a => t.assignments.includes(a.id) || t.submissions.includes(a.requestId));
}
function milestoneFor(d, all, id) {
    const seen = new Set();
    while (id && !seen.has(id)) {
        seen.add(id);
        if (d.links[id])
            return d.links[id];
        id = all.find(a => a.id === id)?.parentId ?? null;
    }
    return null;
}
export const SCORECARD_OPERATIONS = {
    'scorecard.read': { params: ['id'], summary: 'Read evidence-based assignment counts, prospective scope, manager ledger and milestone trends. No model calls.' },
    'scorecard.ledger': { params: ['id', 'before', 'limit'], summary: 'Page the durable manager ledger newest first; before is the exclusive index cursor.' },
    'scorecard.plan': { params: ['id', 'milestoneId', 'title', 'points', 'requestId'], requestId: 'requestId', summary: 'Append an immutable prospective milestone weight before its work begins.' },
    'scorecard.activity': { params: ['id', 'milestoneId', 'assignmentId', 'category', 'note', 'activeSeconds', 'retrospective', 'requestId'], requestId: 'requestId', summary: 'Append one idempotent Codex work entry. Unknown effort stays null; retrospective reports are labelled.' },
    'scorecard.accept': { params: ['id', 'milestoneId', 'owner', 'assignmentId', 'note', 'evidence', 'requestId'], requestId: 'requestId', summary: 'Record independently reviewed milestone completion and attribution; Pi/mixed requires an accepted linked assignment.' },
};
/** Called before submission side effects; children inherit their parent's milestone. */
export function checkMilestone(s, t, p) {
    const d = data(s, t.id), parent = p.parentId ? milestoneFor(d, rows(s, t), p.parentId) : null;
    const id = p.milestoneId ?? parent;
    if (!id)
        return;
    const m = d.milestones.find(m => m.id === id);
    if (!m || m.accepted)
        throw new StoreError('invalid_params', 'Select a planned, unfinished milestone.');
    if (parent && parent !== m.id)
        throw new StoreError('conflict', 'A continuation cannot change its milestone.');
}
export function linkMilestone(s, t, p, assignment) {
    if (!p.milestoneId)
        return;
    const d = data(s, t.id), m = d.milestones.find(m => m.id === p.milestoneId);
    if (!m || assignment.createdAt < m.plannedAt)
        throw new StoreError('conflict', 'Weights must be recorded before assignment creation.');
    if (d.links[assignment.id] && d.links[assignment.id] !== m.id)
        throw new StoreError('conflict', 'Assignment already belongs to another milestone.');
    d.links[assignment.id] = m.id;
    save(s, t.id, d);
}
export function activityCategory(p, fallback) {
    const v = p.activityCategory ?? fallback;
    if (!CATEGORIES.includes(v))
        throw new StoreError('invalid_params', 'Unknown activityCategory.');
    return v;
}
export function recordWorkflowActivity(s, t, eventId, category, note, assignmentId) {
    const d = data(s, t.id), id = `event:${eventId}`;
    const old = d.entries.find(e => e.id === id);
    if (old) {
        if (old.category !== category)
            throw new StoreError('conflict', 'Recorded event category differs.');
        return;
    }
    append(s, t, d, { id, at: Date.now(), category, note: note.slice(0, 1200), source: 'workflow', assignmentId, milestoneId: null, activeSeconds: null, retrospective: false });
}
function append(s, t, d, e) {
    if (d.entries.length >= 10000)
        throw new StoreError('capacity', 'Ledger has 10000 entries; start another workflow.');
    s.withTransaction(() => {
        d.entries.push(e);
        save(s, t.id, d);
        s.appendActivity({ kind: 'codex.activity', projectId: t.projectId, assignmentId: e.assignmentId, requestId: null, dedupKey: `scorecard:${t.id}:${e.id}`, data: e });
    });
}
export function scorecardOperation(s, method, p) {
    const t = task(s, text(p, 'id', 200));
    if (method === 'scorecard.read')
        return readScorecard(s, t);
    if (method === 'scorecard.ledger') {
        const entries = data(s, t.id).entries, before = p.before ?? entries.length, limit = p.limit ?? 30;
        if (!Number.isInteger(before) || before < 0 || before > entries.length || !Number.isInteger(limit) || limit < 1 || limit > 50)
            throw new StoreError('invalid_params', 'Invalid ledger cursor/limit.');
        const start = Math.max(0, before - limit);
        return { entries: entries.slice(start, before).reverse(), nextBefore: start || null, total: entries.length };
    }
    if (!(method in SCORECARD_OPERATIONS))
        throw new StoreError('method_not_found', 'Unknown scorecard method.');
    const requestId = text(p, 'requestId', 200);
    return s.withTransaction(() => {
        const j = s.beginJournal(method, requestId, p);
        if (j.replayed && j.record.status === 'ready')
            return s.getControl(`workflow-scorecard-result:${method}:${requestId}`);
        const d = data(s, t.id);
        let result;
        if (method === 'scorecard.plan') {
            if (t.state !== 'active')
                throw new StoreError('retired_workflow', 'Cannot plan scope for a retired workflow.');
            const id = text(p, 'milestoneId', 80), title = text(p, 'title', 160);
            if (!Number.isInteger(p.points) || p.points < 1 || p.points > 100)
                throw new StoreError('invalid_params', 'points must be 1–100.');
            if (d.milestones.some(m => m.id === id))
                throw new StoreError('conflict', 'Milestone weights and titles are immutable; retry the original request.');
            if (d.milestones.length >= 100)
                throw new StoreError('capacity', 'At most 100 milestones per workflow.');
            const m = { id, title, points: p.points, plannedAt: Date.now(), accepted: null };
            d.milestones.push(m);
            save(s, t.id, d);
            result = { milestone: m };
        }
        else if (method === 'scorecard.activity') {
            const category = activityCategory({ activityCategory: text(p, 'category', 80) }, 'planning'), note = text(p, 'note');
            const assignmentId = p.assignmentId ?? null, milestoneId = p.milestoneId ?? null;
            const all = rows(s, t);
            if (assignmentId && !all.some(a => a.id === assignmentId))
                throw new StoreError('wrong_task', 'Assignment is outside this workflow.');
            if (milestoneId && !d.milestones.some(m => m.id === milestoneId))
                throw new StoreError('not_found', 'Unknown milestone.');
            const linked = milestoneFor(d, all, assignmentId);
            if (linked && milestoneId && linked !== milestoneId)
                throw new StoreError('conflict', 'Milestone and assignment disagree.');
            const seconds = p.activeSeconds ?? null;
            if (seconds !== null && (!Number.isInteger(seconds) || seconds < 0 || seconds > 86400))
                throw new StoreError('invalid_params', 'activeSeconds must be measured seconds (0–86400), or omitted.');
            if (p.retrospective !== undefined && typeof p.retrospective !== 'boolean')
                throw new StoreError('invalid_params', 'retrospective must be boolean.');
            const e = { id: `report:${requestId}`, at: Date.now(), category, note, source: 'reported', assignmentId, milestoneId, activeSeconds: seconds, retrospective: p.retrospective ?? false };
            append(s, t, d, e);
            result = { entry: e };
        }
        else {
            const m = d.milestones.find(m => m.id === p.milestoneId);
            if (!m)
                throw new StoreError('not_found', 'Unknown milestone.');
            if (m.accepted)
                throw new StoreError('conflict', 'Milestone already accepted; retry its original request.');
            if (!['pi', 'codex', 'mixed'].includes(p.owner))
                throw new StoreError('invalid_params', 'owner must be pi, codex, or mixed.');
            const all = rows(s, t), linked = all.filter(a => milestoneFor(d, all, a.id) === m.id);
            if (linked.some(a => a.leasePath || !['accepted', 'cancelled', 'revision_requested'].includes(a.state)))
                throw new StoreError('review_required', 'Settle and review all milestone assignments first.');
            if (p.owner !== 'codex' && !linked.some(a => a.id === p.assignmentId && a.state === 'accepted'))
                throw new StoreError('review_required', 'Pi/mixed completion requires an accepted linked assignment.');
            if (p.assignmentId && !linked.some(a => a.id === p.assignmentId && a.state === 'accepted'))
                throw new StoreError('wrong_task', 'Evidence assignment is not accepted in this milestone.');
            const direct = d.entries.some(e => ['implementation', 'repair'].includes(e.category) && (e.milestoneId ?? milestoneFor(d, all, e.assignmentId)) === m.id);
            if (p.owner === 'pi' && direct)
                throw new StoreError('conflict', 'Codex implementation/repair is recorded; attribute this milestone to mixed.');
            m.accepted = { at: Date.now(), owner: p.owner, note: text(p, 'note'), evidence: text(p, 'evidence'), assignmentId: p.assignmentId ?? null };
            save(s, t.id, d);
            result = { milestone: m };
        }
        s.setWorkflowControl(`workflow-scorecard-result:${method}:${requestId}`, result);
        s.completeJournal(method, requestId, t.id);
        return result;
    });
}
export function readScorecard(s, t) {
    const d = data(s, t.id), all = rows(s, t);
    const entries = d.entries.map(e => ({ ...e, milestoneId: e.milestoneId ?? milestoneFor(d, all, e.assignmentId) }));
    const counts = Object.fromEntries(CATEGORIES.map(c => [c, entries.filter(e => e.category === c).length]));
    const milestones = d.milestones.map(m => {
        const assignments = all.filter(a => milestoneFor(d, all, a.id) === m.id), local = entries.filter(e => e.milestoneId === m.id);
        const revisions = assignments.filter(a => a.state === 'revision_requested').length;
        const direct = local.some(e => ['implementation', 'repair'].includes(e.category));
        // Late disclosure of direct Codex work cannot leave a Pi-only attribution intact.
        return { ...m, owner: m.accepted ? (m.accepted.owner === 'pi' && direct ? 'mixed' : m.accepted.owner) : null,
            assignments: assignments.length, revisions, firstReview: m.accepted && assignments.some(a => a.state === 'accepted') ? revisions === 0 : null,
            steering: local.filter(e => ['debugging_guidance', 'revision_guidance'].includes(e.category)).length,
            productDecisions: local.filter(e => e.category === 'product_decision').length,
            directCodex: local.filter(e => ['implementation', 'repair'].includes(e.category)).length,
            unclassifiedQuestions: local.filter(e => e.category === 'question_unclassified').length,
            reportedSeconds: local.some(e => e.activeSeconds !== null) ? local.reduce((n, e) => n + (e.activeSeconds ?? 0), 0) : null };
    });
    const completed = milestones.filter(m => m.accepted), points = (owner) => completed.filter(m => !owner || m.owner === owner).reduce((n, m) => n + m.points, 0);
    const acceptedPoints = points(), plannedPoints = milestones.reduce((n, m) => n + m.points, 0);
    const eligible = completed.filter(m => m.firstReview !== null);
    return {
        workflowId: t.id, observedAt: Date.now(), coverage: 'Workflow answers/reviews plus explicitly reported Codex work. Missing records are not zero effort. Scope points compare this plan only; no token/time savings inferred.',
        assignments: { total: all.length, accepted: all.filter(a => a.state === 'accepted').length, revisions: all.filter(a => a.state === 'revision_requested').length, cancelled: all.filter(a => a.state === 'cancelled').length, unmapped: all.filter(a => !milestoneFor(d, all, a.id)).length },
        scope: { plannedPoints, acceptedPoints, piPoints: points('pi'), codexPoints: points('codex'), mixedPoints: points('mixed'), piShare: acceptedPoints ? points('pi') / acceptedPoints : null, completion: plannedPoints ? acceptedPoints / plannedPoints : null },
        codex: { counts, total: entries.length, reportedSeconds: entries.some(e => e.activeSeconds !== null) ? entries.reduce((n, e) => n + (e.activeSeconds ?? 0), 0) : null, timedEntries: entries.filter(e => e.activeSeconds !== null).length, unallocated: entries.filter(e => !e.milestoneId).length },
        firstReview: { accepted: eligible.filter(m => m.firstReview).length, total: eligible.length },
        milestones, trends: completed.sort((a, b) => a.accepted.at - b.accepted.at).slice(-20),
        ledger: entries.slice(-30).reverse(), ledgerCount: entries.length,
        usage: { codex: null, pi: null, note: 'Token totals are not part of this scorecard. Pi session counts remain available through sessions.usage; billing and Codex effort are not inferred.' },
    };
}
//# sourceMappingURL=scorecard.js.map