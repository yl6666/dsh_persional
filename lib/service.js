/**
 * RepoBoard service - the Cordis host half of dsh-repo-board
 * (docs/product-design.md 8). Owns the active RepoGraph store: opening and
 * persisting the graph document, scanning repo directories through the
 * extraction pipeline, and exposing the graph algorithms plus manual edit
 * operations to plugins and tools.
 * @module dsh-repo-board
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Service } from '@deepseek-ai/cordis';
import { dependencies, impact, impactReport, topologicalUnits, } from "./graph/algorithms.js";
import { RepoGraphStore } from "./graph/store.js";
import { buildEdgesFromManifests, parseManifests } from "./extract/manifest.js";
import { extractProvidedContracts, resolveContractConsumers, } from "./extract/contract.js";
import { scannedFingerprint, scanRepoDirectory } from "./scan/fs.js";
import { executePlans } from "./exec/executor.js";
import { RequirementRecord } from "./pipeline/flow.js";
/**
 * The active multi-repo board: one open RepoGraph per service instance.
 * Graph mutations persist to the file the graph was opened with; queries
 * always read detached immutable documents. The requirement registry (the
 * artifact chain per dispatched requirement, 13.3) persists next to the
 * graph file and reloads on open.
 */
export class RepoBoardService extends Service {
    store;
    graphPath;
    requirements = new Map();
    requirementSeq = 0;
    /** Repos with a dispatch in flight (6.1 single-pipeline-per-repo mutex). */
    activeRepos = new Set();
    /** Git gateway from the latest dispatch, used by the submit gate (16.1). */
    lastGit;
    constructor(ctx) {
        super(ctx, 'repoBoard');
    }
    /** True once a graph has been opened. */
    get isOpen() {
        return this.store !== undefined;
    }
    /** Detached snapshot of the active graph. */
    get document() {
        return this.requireStore().toDocument();
    }
    /** Persisted requirement records, newest first. */
    listRequirements() {
        return [...this.requirements.values()].map(record => record.toDocument());
    }
    /** One requirement record by id, or undefined. */
    getRequirement(id) {
        return this.requirements.get(id);
    }
    /**
     * Register a new dispatched requirement (step input); assigns and persists
     * the next `req-<n>` id.
     */
    async createRequirement(draft) {
        this.requireStore();
        this.requirementSeq += 1;
        const id = 'req-' + this.requirementSeq;
        const record = RequirementRecord.create(id, draft);
        this.requirements.set(id, record);
        await this.persistRequirements();
        return { id, record };
    }
    /** Replace one requirement record (transition results) and persist. */
    async setRequirement(id, record) {
        const current = this.requirements.get(id);
        if (current === undefined)
            throw new Error('repo board: unknown requirement ' + id);
        if (record.toDocument().id !== id)
            throw new Error('repo board: requirement id mismatch');
        this.requirements.set(id, record);
        await this.persistRequirements();
    }
    /** Replace a record via its own id (submit decisions); persists. */
    async replaceRequirement(record) {
        await this.setRequirement(record.toDocument().id, record);
    }
    /**
     * Open (or create) the graph document at `graphPath`. A missing file
     * creates an empty graph for `project`; an existing file must validate.
     * Requirement records persist alongside and reload here.
     */
    async open(project, graphPath) {
        let raw;
        try {
            raw = await readFile(graphPath, 'utf8');
        }
        catch (error) {
            if (error.code === 'ENOENT') {
                this.store = RepoGraphStore.create(project);
                this.graphPath = graphPath;
                await this.persist();
                return this.document;
            }
            throw error;
        }
        const parsed = JSON.parse(raw);
        this.store = RepoGraphStore.load(parsed);
        this.graphPath = graphPath;
        await this.loadRequirements();
        return this.document;
    }
    /**
     * Scan repo directories and merge manifest + contract edges into the active
     * graph (design 4.3 tier one and two). Nodes are upserted with display
     * names from their manifests, build-system metadata, and rescan
     * fingerprints. Merging is idempotent; manual edges and suppressions are
     * preserved by the store's merge strategy.
     */
    async scan(repos) {
        const store = this.requireStore();
        const manifestScans = [];
        const contractsByRepo = new Map();
        const filesByRepo = {};
        for (const repo of repos) {
            const files = await scanRepoDirectory(repo.path);
            const scan = parseManifests(repo.key, files.manifest);
            manifestScans.push(scan);
            const node = {
                name: scan.provides[0]?.name ?? repo.key,
                path: repo.path,
                labels: [],
                fingerprint: scannedFingerprint(files),
                meta: { build: scan.buildSystems },
            };
            store.upsertNode(repo.key, node);
            const provided = extractProvidedContracts(repo.key, files.contracts);
            if (provided.length > 0)
                contractsByRepo.set(repo.key, provided);
            filesByRepo[repo.key] = { ...files.contracts, ...files.sources };
        }
        const buildEdges = buildEdgesFromManifests(manifestScans);
        const contractEdges = resolveContractConsumers({ contracts: contractsByRepo, files: filesByRepo });
        store.mergeAutoEdges([...buildEdges, ...contractEdges]);
        await this.persist();
        return this.document;
    }
    /** Upsert one repo node by hand (graph editor backend). Persists. */
    async upsertNode(key, node) {
        this.requireStore().upsertNode(key, node);
        await this.persist();
        return this.document;
    }
    /** Draw one edge by hand; manual edges beat auto merges forever (7.1). Persists. */
    async addManualEdge(input) {
        this.requireStore().addManualEdge(input);
        await this.persist();
        return this.document;
    }
    /** Suppress one relation; auto analysis stops suggesting it (7.1). Persists. */
    async suppressEdge(id, reason) {
        this.requireStore().suppressEdge(id, reason);
        await this.persist();
        return this.document;
    }
    /** Confirm one candidate edge. Persists. */
    async confirmEdge(id) {
        this.requireStore().confirmEdge(id);
        await this.persist();
        return this.document;
    }
    /** Drop one edge entirely. Persists. */
    async removeEdge(id) {
        this.requireStore().removeEdge(id);
        await this.persist();
        return this.document;
    }
    /** Drop one repo node and its incident edges. Persists. */
    async removeNode(key) {
        this.requireStore().removeNode(key);
        await this.persist();
        return this.document;
    }
    /** Merge raw auto edges (pipeline/testing hook). */
    mergeAutoEdges(inputs) {
        return this.requireStore().mergeAutoEdges(inputs);
    }
    /** Forward reachable set: everything `repo` depends on. */
    dependencies(repo, options) {
        return dependencies(this.document, repo, options);
    }
    /** Reverse reachable set: the blast radius of `repo`. */
    impact(repo, options) {
        return impact(this.document, repo, options);
    }
    /** Full blast-radius report for `repo`. */
    impactReport(repo, options) {
        return impactReport(this.document, repo, options);
    }
    /** Topological scheduling units, upstream first, cycles condensed (13.2). */
    topologicalUnits(repos, options) {
        return topologicalUnits(this.document, repos, options);
    }
    /**
     * Steps [5]-[6]: execute a planned requirement's repo tasks upstream first
     * (design 6). Repo checkout paths come from the graph nodes; the injected
     * task runs once per plan (one DSH session per repo in production).
     * Manual commit policy stops each repo at a submit request (16.1); the
     * same requirement's repos may not overlap another running dispatch (6.1).
     */
    async dispatchRequirement(record, task, options = {}) {
        if (record.status !== 'planned') {
            throw new Error('repo board: only planned requirements can be dispatched');
        }
        const plans = record.toDocument().plans;
        if (plans === undefined)
            throw new Error('repo board: planned requirement carries no plans');
        const repoPaths = {};
        for (const key of Object.keys(this.document.nodes)) {
            const path = this.document.nodes[key]?.path;
            if (path !== undefined)
                repoPaths[key] = path;
        }
        // Per-repo mutex (6.1): one pipeline per repo at a time.
        const repos = plans.map(plan => plan.repo);
        const conflicts = repos.filter(repo => this.activeRepos.has(repo));
        if (conflicts.length > 0) {
            throw new Error('repo board: these repos already have a running dispatch: ' + conflicts.sort().join(', '));
        }
        for (const repo of repos)
            this.activeRepos.add(repo);
        try {
            const run = await executePlans(plans, task, {
                repoPaths,
                concurrency: options.concurrency,
                git: options.git,
                commitPolicy: options.commitPolicy,
                maxAttempts: options.maxAttempts,
                branchBase: 'ai-delivery/' + record.toDocument().id,
            });
            this.lastGit = options.git;
            return { record: record.dispatch(run), run };
        }
        finally {
            for (const repo of repos)
                this.activeRepos.delete(repo);
        }
    }
    /**
     * Human submit gate (16.1): approve one repo's pending submit request by
     * committing its changes host-side on the requirement branch. Requires the
     * git gateway from the dispatch that created the pending state.
     */
    async approveSubmit(record, repo, options = {}) {
        const run = record.toDocument().run;
        if (record.status !== 'dispatched' || run === undefined) {
            throw new Error('repo board: only a dispatched requirement can be submitted');
        }
        const entry = run.perRepo.find(item => item.repo === repo);
        if (entry === undefined)
            throw new Error('repo board: no run entry for repo ' + repo);
        if (entry.state !== 'submit-pending' || entry.submitRequest === undefined) {
            throw new Error('repo board: repo ' + repo + ' is not waiting for a submit decision (state: ' + entry.state + ')');
        }
        if (this.lastGit === undefined) {
            throw new Error('repo board: no git gateway from the dispatch - cannot commit');
        }
        const repoPath = this.document.nodes[repo]?.path;
        if (repoPath === undefined)
            throw new Error('repo board: repo ' + repo + ' has no checkout path in the graph');
        const commit = await this.lastGit.commitAll(repoPath, options.message ?? 'ai(' + repo + '): ' + entry.submitRequest.summary);
        const nextRun = {
            perRepo: run.perRepo.map(item => item.repo === repo ? { ...item, state: 'submitted', commit } : item),
            errors: run.errors.filter(error => !error.startsWith(repo + ':')),
        };
        const next = record.updateRun(nextRun);
        await this.replaceRequirement(next);
        return next;
    }
    /**
     * Reject one repo's pending submit request (16.1): the repo lands in
     * needs-human with the rejection recorded, and no commit is made.
     */
    async rejectSubmit(record, repo, reason) {
        const run = record.toDocument().run;
        if (record.status !== 'dispatched' || run === undefined) {
            throw new Error('repo board: only a dispatched requirement can be rejected');
        }
        const entry = run.perRepo.find(item => item.repo === repo);
        if (entry === undefined)
            throw new Error('repo board: no run entry for repo ' + repo);
        if (entry.state !== 'submit-pending') {
            throw new Error('repo board: repo ' + repo + ' is not waiting for a submit decision (state: ' + entry.state + ')');
        }
        const rejection = 'submit rejected for ' + repo + (reason === undefined || reason === '' ? '' : ': ' + reason);
        const nextRun = {
            perRepo: run.perRepo.map(item => item.repo === repo ? { ...item, state: 'needs-human' } : item),
            errors: [...run.errors.filter(error => !error.startsWith(repo + ':')), rejection],
        };
        const next = record.updateRun(nextRun);
        await this.replaceRequirement(next);
        return next;
    }
    requireStore() {
        if (this.store === undefined) {
            throw new Error('repo board: no graph is open - call open(project, graphPath) first');
        }
        return this.store;
    }
    requirementsPath() {
        const graphPath = this.graphPath ?? 'graph.json';
        const dir = dirname(graphPath);
        const base = graphPath.split(/[\\/]/).pop() ?? 'graph.json';
        return dir + '/' + base.replace(/\.json$/, '') + '.requirements.json';
    }
    async persistRequirements() {
        if (this.graphPath === undefined)
            return;
        const path = this.requirementsPath();
        await mkdir(dirname(path), { recursive: true });
        const documents = this.listRequirements();
        await writeFile(path, JSON.stringify({ version: 1, seq: this.requirementSeq, requirements: documents }, null, 2), 'utf8');
    }
    async loadRequirements() {
        const path = this.requirementsPath();
        let raw;
        try {
            raw = await readFile(path, 'utf8');
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return;
            throw error;
        }
        const parsed = JSON.parse(raw);
        if (parsed.version !== 1 || !Array.isArray(parsed.requirements)) {
            throw new Error('repo board: malformed requirements file ' + path);
        }
        this.requirements.clear();
        for (const document of parsed.requirements) {
            const record = RequirementRecord.load(document);
            this.requirements.set(record.toDocument().id, record);
        }
        this.requirementSeq = typeof parsed.seq === 'number' ? parsed.seq : this.requirements.size;
    }
    async persist() {
        if (this.graphPath === undefined)
            return;
        await mkdir(dirname(this.graphPath), { recursive: true });
        await writeFile(this.graphPath, JSON.stringify(this.document, null, 2), 'utf8');
    }
}
export default RepoBoardService;
