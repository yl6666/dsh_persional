/**
 * The RepoTask binding that runs one DSH subagent session per repo
 * (docs/product-design.md 6, 12 - subagents first).
 *
 * Each repo plan becomes one one-shot subagent with a structured-output
 * schema; the session works inside the repo checkout and commits. The
 * binding maps the subagent outcome onto the executor's RepoTaskOutcome.
 * @module dsh-repo-board
 */
import { DEFAULT_SUBAGENT_PROVIDER } from "./types.js";
import { buildRepoSessionPrompt, repoSessionOutputSchema } from "./prompt.js";
function isRepoSessionOutput(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const candidate = value;
    if (typeof candidate.summary !== 'string' || candidate.summary === '')
        return false;
    if (!Array.isArray(candidate.changedFiles))
        return false;
    if (candidate.commit !== undefined && typeof candidate.commit !== 'string')
        return false;
    return true;
}
/**
 * Build the per-repo task that spawns one subagent session per plan. The
 * label and prompt derive purely from the plan; upstream results flow into
 * later prompts through the shared collector.
 */
export function buildRepoSessionTask(options) {
    return async ({ plan, repoPath, branch, isRepo, attempt, previousErrors }) => {
        // A path that is not its own work tree root must never be committed at:
        // git there resolves into the enclosing repo. The session is told to
        // keep away from git entirely; the host commits nothing either.
        const noGit = isRepo === false;
        const prompt = buildRepoSessionPrompt({
            plan,
            spec: options.spec,
            repoPath,
            branch,
            attempt,
            previousErrors,
            noGit,
            selfCommit: noGit ? false : options.selfCommit,
            upstreamResults: options.upstream.results.filter(result => plan.prerequisites.includes(result.repo)),
        });
        const run = await options.subagents.start(options.provider ?? DEFAULT_SUBAGENT_PROVIDER, {
            label: 'repo-board/' + plan.repo,
            prompt: [{ type: 'text', text: prompt }],
            parent: options.parent,
            signal: options.signal,
            outputSchema: repoSessionOutputSchema,
        });
        const result = await run.result;
        const sessionId = String(run.id ?? '');
        if (isRepoSessionOutput(result.structured)) {
            const output = result.structured;
            options.upstream.results.push({ repo: plan.repo, summary: output.summary, commit: output.commit });
            return {
                state: 'succeeded',
                sessionId,
                commit: output.commit,
                diffSummary: output.changedFiles.join(', '),
            };
        }
        const text = result.output
            .filter((block) => block.type === 'text')
            .map(block => block.text)
            .join('\n')
            .trim();
        const diagnostic = result.diagnostic === undefined ? '' : ' Diagnostic: ' + result.diagnostic;
        return {
            state: 'failed',
            sessionId,
            error: 'repo session ended without structured output (stopReason: ' + result.stopReason + ')' +
                diagnostic + (text === '' ? '' : ': ' + text.slice(0, 500)),
        };
    };
}
