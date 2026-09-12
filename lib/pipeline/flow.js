/**
 * Requirement pipeline flow - the pure transitions between dispatch-step
 * artifacts (docs/product-design.md 13.3): clarification gating, graph-backed
 * impact analysis, plan scaffolding, and review findings.
 *
 * The LLM seam lives above this module: a planner fills the skeletons these
 * functions produce. Everything here is deterministic over the RepoGraph.
 * @module dsh-repo-board
 */
import { impact, topologicalUnits, writeScopeConflicts, } from "../graph/algorithms.js";
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/**
 * Effective answers of one session: explicit answers, plus defaults for
 * unanswered non-blocking questions (5.2: 可默认级给默认).
 */
export function effectiveAnswers(session) {
    const result = {};
    for (const question of session.questions) {
        const answered = session.answers?.[question.id];
        if (answered !== undefined && answered !== '')
            result[question.id] = answered;
        else if (!question.blocking && question.default !== undefined)
            result[question.id] = question.default;
    }
    return result;
}
/** True when every blocking question has an explicit answer. */
export function blockingAnswersComplete(session) {
    const answers = session.answers ?? {};
    return session.questions.every(q => !q.blocking || (answers[q.id] ?? '') !== '');
}
/**
 * Step [2]: analyze the spec's blast radius over the graph. candidateRepos
 * not present in the graph are reported as unknownRepos (5.2 anomaly) and
 * excluded from topology instead of crashing.
 */
export function analyzeImpact(graph, spec) {
    const known = spec.candidateRepos.filter(repo => graph.nodes[repo] !== undefined);
    const unknownRepos = spec.candidateRepos.filter(repo => graph.nodes[repo] === undefined);
    const affected = new Set(known);
    for (const repo of known) {
        for (const hit of impact(graph, repo))
            affected.add(hit);
    }
    const affectedRepos = [...affected].sort();
    const units = topologicalUnits(graph, affectedRepos);
    const topologicalOrder = units.map(unit => ({
        repos: [...unit.repos],
        depth: unit.depth,
        hasContractCycle: unit.hasContractCycle,
    }));
    const inAffected = new Set(affectedRepos);
    const unitIndexByRepo = new Map();
    units.forEach((unit, index) => {
        for (const repo of unit.repos)
            unitIndexByRepo.set(repo, index);
    });
    const criticalEdges = [];
    for (const edge of graph.edges) {
        if (edge.status === 'suppressed')
            continue;
        if (edge.type !== 'contract')
            continue;
        if (!inAffected.has(edge.from) || !inAffected.has(edge.to))
            continue;
        const sameUnit = unitIndexByRepo.get(edge.from) !== undefined &&
            unitIndexByRepo.get(edge.from) === unitIndexByRepo.get(edge.to);
        criticalEdges.push({
            from: edge.from,
            to: edge.to,
            contract: edge.contractRef?.name,
            reason: sameUnit ? 'cycle' : 'contract',
        });
    }
    criticalEdges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
    return { affectedRepos, topologicalOrder, criticalEdges, unknownRepos };
}
/** Downstream consumers of one repo's contracts, precise to the contract (5.3). */
export function planDownstream(graph, repo) {
    const downstream = graph.edges
        .filter(edge => edge.status !== 'suppressed' && edge.type === 'contract' && edge.to === repo)
        .map(edge => ({ repo: edge.from, via: edge.contractRef?.name ?? '(unnamed)' }));
    const seen = new Set();
    return downstream
        .filter(entry => {
        const key = entry.repo + '::' + entry.via;
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    })
        .sort((a, b) => a.repo.localeCompare(b.repo) || a.via.localeCompare(b.via));
}
/**
 * Step [3] scaffold: deterministic per-repo plan skeletons in execution
 * order. Prerequisites come from the graph (upstream first); the planner
 * LLM fills summary/changes/writeScopes/breaking before attach.
 */
export function scaffoldPlans(graph, analysis, spec) {
    const affected = new Set(analysis.affectedRepos);
    const plans = analysis.affectedRepos.map(repo => {
        const prerequisites = [
            ...new Set(graph.edges
                .filter(edge => edge.status !== 'suppressed' && edge.from === repo && affected.has(edge.to))
                .map(edge => edge.to)),
        ].sort();
        return {
            repo,
            summary: '承接需求目标的 ' + repo + ' 侧改动（方案待生成）',
            changes: [],
            writeScopes: [],
            contractImpact: { breaking: [], downstream: planDownstream(graph, repo) },
            prerequisites,
            acceptance: [...spec.acceptance],
        };
    });
    return plans;
}
/** Write-scope conflicts across a plan set (13.2-4). */
export function planConflicts(plans) {
    const tasks = plans.map(plan => ({ repo: plan.repo, writeScopes: [...plan.writeScopes] }));
    return writeScopeConflicts(tasks);
}
/** Collect the review payload for a plan set against its analysis. */
export function reviewFindings(graph, analysis, plans) {
    return {
        conflicts: planConflicts(plans),
        breakingChanges: plans
            .filter(plan => plan.contractImpact.breaking.length > 0)
            .map(plan => ({ repo: plan.repo, breaking: [...plan.contractImpact.breaking] })),
        criticalEdges: analysis.criticalEdges,
    };
}
function validateQuestions(questions) {
    const seen = new Set();
    for (const question of questions) {
        if (question.id === '' || seen.has(question.id)) {
            throw new TypeError('clarification question ids must be non-empty and unique');
        }
        seen.add(question.id);
        if (question.text === '')
            throw new TypeError('clarification question text must be non-empty');
        if (question.kind === 'select' && (question.options ?? []).length === 0) {
            throw new TypeError('select question ' + question.id + ' needs options');
        }
    }
}
function validateSpec(spec) {
    if (spec.text === '')
        throw new TypeError('spec text must be non-empty');
    if (spec.candidateRepos.length === 0) {
        throw new TypeError('spec must name at least one candidate repo - ask which repos are involved');
    }
}
function validatePlans(plans, analysis) {
    const affected = new Set(analysis.affectedRepos);
    const planned = new Set();
    for (const plan of plans) {
        if (plan.repo === '')
            throw new TypeError('plan repo must be non-empty');
        if (planned.has(plan.repo))
            throw new TypeError('duplicate plan for repo ' + plan.repo);
        planned.add(plan.repo);
        if (!affected.has(plan.repo)) {
            throw new TypeError('plan for ' + plan.repo + ' is outside the analyzed blast radius');
        }
        if (plan.summary === '')
            throw new TypeError('plan for ' + plan.repo + ' needs a summary');
        for (const prerequisite of plan.prerequisites) {
            if (prerequisite === plan.repo) {
                throw new TypeError('plan for ' + plan.repo + ' depends on itself');
            }
        }
    }
    for (const plan of plans) {
        for (const prerequisite of plan.prerequisites) {
            if (!planned.has(prerequisite)) {
                throw new TypeError('plan for ' + plan.repo + ' requires a plan for ' + prerequisite);
            }
        }
    }
}
function validateAnswers(session, answers) {
    const known = new Set(session.questions.map(question => question.id));
    for (const id of Object.keys(answers)) {
        if (!known.has(id))
            throw new TypeError('answer for unknown question id: ' + id);
    }
}
/**
 * The artifact chain for one dispatched requirement. Transitions validate
 * their preconditions and return a new record; `toDocument()` persists.
 */
export class RequirementRecord {
    doc;
    constructor(doc) {
        this.doc = doc;
    }
    /** Start a record from the raw dispatched text. */
    static create(id, draft, createdAt = new Date().toISOString()) {
        if (id === '')
            throw new TypeError('requirement id must be non-empty');
        if (draft.text === '')
            throw new TypeError('draft text must be non-empty');
        return new RequirementRecord({
            version: 1,
            id,
            createdAt,
            status: 'draft',
            draft,
        });
    }
    /** Restore a record from its persisted document. */
    static load(doc) {
        if (doc.version !== 1)
            throw new TypeError('unsupported requirement document version');
        if (doc.id === '' || doc.draft.text === '')
            throw new TypeError('malformed requirement document');
        return new RequirementRecord(doc);
    }
    /** Persistable snapshot. */
    toDocument() {
        return this.doc;
    }
    get status() {
        return this.doc.status;
    }
    get analysis() {
        return this.doc.analysis;
    }
    /** [0] Gate the requirement behind a batch of clarification questions. */
    beginClarification(questions) {
        if (this.doc.status !== 'draft' && this.doc.status !== 'clarifying') {
            throw new TypeError('clarification can only start from draft or clarifying status');
        }
        validateQuestions(questions);
        // A follow-up batch replaces the question set but keeps the answers
        // already recorded for questions that survive in it - the batched
        // submission contract ("answers may arrive in batches") means a second
        // round must never wipe what the first round already learned. Answers
        // for questions that left the set go with them.
        const previous = this.doc.clarification?.answers ?? {};
        const surviving = new Set(questions.map(question => question.id));
        const answers = Object.fromEntries(Object.entries(previous).filter(([id]) => surviving.has(id)));
        return new RequirementRecord({
            ...this.doc,
            status: 'clarifying',
            clarification: {
                questions,
                ...(Object.keys(answers).length > 0 ? { answers } : {}),
            },
        });
    }
    /** Record (possibly partial) answers for the open questions. */
    resolveClarification(answers) {
        if (this.doc.status !== 'clarifying' || this.doc.clarification === undefined) {
            throw new TypeError('no clarification session is open');
        }
        validateAnswers(this.doc.clarification, answers);
        // Merge, not replace: a batch only carries its own answers, and earlier
        // batches' answers must survive (batched-submission contract).
        const previous = this.doc.clarification.answers ?? {};
        return new RequirementRecord({
            ...this.doc,
            clarification: { ...this.doc.clarification, answers: { ...previous, ...answers } },
        });
    }
    /** [0]+[1] Attach the completed spec; blocking questions must be answered. */
    attachSpec(spec) {
        if (this.doc.status !== 'clarifying' && this.doc.status !== 'draft') {
            throw new TypeError('a spec is already attached');
        }
        if (this.doc.clarification !== undefined && !blockingAnswersComplete(this.doc.clarification)) {
            throw new TypeError('blocking clarification questions must be answered before attaching a spec');
        }
        validateSpec(spec);
        return new RequirementRecord({ ...this.doc, status: 'spec-ready', spec });
    }
    /** [2] Analyze the blast radius; requires a spec, uses the graph. */
    analyze(graph) {
        if (this.doc.status !== 'spec-ready' || this.doc.spec === undefined) {
            throw new TypeError('analysis requires a spec-ready requirement');
        }
        const analysis = analyzeImpact(graph, this.doc.spec);
        return new RequirementRecord({ ...this.doc, status: 'analyzed', analysis });
    }
    /** [3] Attach the per-repo plan set. */
    attachPlans(plans) {
        if (this.doc.status !== 'analyzed' || this.doc.analysis === undefined) {
            throw new TypeError('plans require an analyzed requirement');
        }
        validatePlans(plans, this.doc.analysis);
        return new RequirementRecord({ ...this.doc, status: 'planned', plans });
    }
    /** [5] Mark dispatched, optionally attaching the finished execution run. */
    dispatch(run) {
        if (this.doc.status !== 'planned') {
            throw new TypeError('only planned requirements can be dispatched');
        }
        return new RequirementRecord({ ...this.doc, status: 'dispatched', run });
    }
    /**
     * Replace the attached run after a submit decision or re-dispatch
     * (16.1): approve turns submit-pending into submitted, reject into
     * needs-human. Only a dispatched record carries a run to replace.
     */
    updateRun(run) {
        if (this.doc.status !== 'dispatched') {
            throw new TypeError('only dispatched requirements have a run to update');
        }
        return new RequirementRecord({ ...this.doc, run });
    }
    /**
     * Return a dispatched requirement to planned for a re-dispatch of its
     * failed repos (17.3 defect loop): the superseded run moves to the
     * append-only runHistory so the failure context survives, and the plans
     * stay attached for the executor to retry against.
     */
    reDispatch() {
        if (this.doc.status !== 'dispatched' || this.doc.run === undefined) {
            throw new TypeError('only dispatched requirements with a run can be re-dispatched');
        }
        return new RequirementRecord({
            ...this.doc,
            status: 'planned',
            run: undefined,
            runHistory: [...(this.doc.runHistory ?? []), this.doc.run],
        });
    }
}
