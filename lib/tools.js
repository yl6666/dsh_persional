/**
 * Model-facing tools for the multi-repo board (docs/product-design.md 8, M4.5).
 *
 * A separate cordis plugin from the service: it consumes `ctx.repoBoard`
 * plus the host's optional tool registry and subagent runtime through
 * hand-rolled structural types (dsh/types.ts), so the package installs with
 * only the base cordis peer dependency. Raw JSON-Schema tool definitions own
 * their argument validation (tools.md), hence the strict parse helpers.
 *
 * Tool set - the eight dispatch steps as model calls:
 * - repo_board_scan: open + scan a repo group into the graph
 * - repo_board_graph: impact / dependencies / topology queries
 * - repo_board_dispatch: register the raw requirement (draft)
 * - repo_board_clarify: record one clarification batch and its answers ([0])
 * - repo_board_spec: attach the spec, analyze, scaffold plans ([0]-[3])
 * - repo_board_plans: attach filled plans + review findings ([3]-[4])
 * - repo_board_execute: one subagent session per repo, upstream first ([5]-[6])
 * - repo_board_submit: human submit gate for manual commit policy (16.1)
 * @module dsh-repo-board/tools
 */
import { hostCapabilities } from "./dsh/types.js";
import { buildRepoSessionTask } from "./dsh/session-task.js";
import { renderRunLine } from "./dsh/prompt.js";
import { reviewFindings, scaffoldPlans } from "./pipeline/flow.js";
import { GitClient, NodeCommandRunner } from "./exec/git.js";
/** Cordis plugin name. */
export const name = 'repo-board-tools';
/**
 * The board service must be live before tools register, and the host's tool
 * registry is required - inject declares it, so apply runs only when
 * ctx.tools exists (real cordis throws on undeclared service reads).
 */
export const inject = ['repoBoard', 'tools'];
function fail(what) {
    throw new Error('repo board: ' + what);
}
function asObject(value, what) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        fail(what + ' must be an object');
    return value;
}
function asString(value, what) {
    if (typeof value !== 'string' || value === '')
        fail(what + ' must be a non-empty string');
    return value;
}
function asStringArray(value, what) {
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
        fail(what + ' must be an array of strings');
    }
    return value;
}
function asBoolean(value, what) {
    if (typeof value !== 'boolean')
        fail(what + ' must be a boolean');
    return value;
}
function parseSpec(value) {
    const input = asObject(value, 'spec');
    return {
        text: asString(input['text'], 'spec.text'),
        goals: asStringArray(input['goals'] ?? [], 'spec.goals'),
        candidateRepos: asStringArray(input['candidateRepos'], 'spec.candidateRepos'),
        constraints: asStringArray(input['constraints'] ?? [], 'spec.constraints'),
        acceptance: asStringArray(input['acceptance'] ?? [], 'spec.acceptance'),
    };
}
function parsePlan(value) {
    const input = asObject(value, 'plan');
    const changes = Array.isArray(input['changes']) ? input['changes'] : [];
    const impact = asObject(input['contractImpact'] ?? { breaking: [], downstream: [] }, 'plan.contractImpact');
    return {
        repo: asString(input['repo'], 'plan.repo'),
        summary: asString(input['summary'], 'plan.summary'),
        changes: changes.map(change => {
            const item = asObject(change, 'plan.changes[]');
            return {
                target: asString(item['target'], 'plan.changes[].target'),
                description: asString(item['description'], 'plan.changes[].description'),
            };
        }),
        writeScopes: asStringArray(input['writeScopes'] ?? [], 'plan.writeScopes'),
        contractImpact: {
            breaking: asStringArray(impact['breaking'] ?? [], 'plan.contractImpact.breaking'),
            downstream: Array.isArray(impact['downstream']) ? impact['downstream'] : [],
        },
        prerequisites: asStringArray(input['prerequisites'] ?? [], 'plan.prerequisites'),
        acceptance: asStringArray(input['acceptance'] ?? [], 'plan.acceptance'),
    };
}
function parseQuestions(value) {
    if (!Array.isArray(value))
        fail('questions must be an array');
    return value.map(item => {
        const question = asObject(item, 'questions[]');
        const kind = asString(question['kind'], 'questions[].kind');
        if (kind !== 'select' && kind !== 'multi-select' && kind !== 'input' && kind !== 'confirm') {
            fail('questions[].kind must be select, multi-select, input, or confirm');
        }
        const options = Array.isArray(question['options']) ? question['options'] : undefined;
        return {
            id: asString(question['id'], 'questions[].id'),
            text: asString(question['text'], 'questions[].text'),
            kind,
            options: options?.map(option => {
                const parsed = asObject(option, 'questions[].options[]');
                return {
                    label: asString(parsed['label'], 'questions[].options[].label'),
                    description: typeof parsed['description'] === 'string' ? parsed['description'] : undefined,
                    recommended: parsed['recommended'] === true,
                };
            }),
            default: question['default'] === undefined ? undefined : asString(question['default'], 'questions[].default'),
            blocking: asBoolean(question['blocking'] ?? false, 'questions[].blocking'),
            context: question['context'] === undefined ? undefined : asString(question['context'], 'questions[].context'),
        };
    });
}
function parseAnswers(value) {
    const input = asObject(value, 'answers');
    const answers = {};
    for (const [key, entry] of Object.entries(input)) {
        answers[key] = asString(entry, 'answers.' + key);
    }
    return answers;
}
function textRender(_args, value) {
    return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}
/**
 * Deep-strip undefined-valued properties, mirroring what JSON.stringify
 * keeps. The real host snapshots tool outputs under lossless-JSON rules
 * (dsh-util-values walkJsonValue) where ONE undefined property value rejects
 * the whole output ("value is not lossless JSON") - optional fields must be
 * absent, not undefined. JSON.stringify silently drops them, which is why
 * fake-host tests never caught this.
 */
function jsonify(value) {
    if (Array.isArray(value))
        return value.map(item => jsonify(item));
    if (typeof value === 'object' && value !== null) {
        const out = {};
        for (const [key, entry] of Object.entries(value)) {
            if (entry === undefined)
                continue;
            out[key] = jsonify(entry);
        }
        return out;
    }
    return value;
}
/** Register one tool with host-safe (lossless-JSON) output normalization. */
function registerTool(tools, tool) {
    tools.register({
        ...tool,
        async execute(args, exec) {
            return jsonify(await tool.execute(args, exec));
        },
    });
}
function summarizeGraph(document) {
    return {
        project: document.project,
        nodes: Object.keys(document.nodes).sort().map(key => ({
            repo: key,
            name: document.nodes[key].name,
            path: document.nodes[key].path,
            labels: document.nodes[key].labels,
        })),
        edges: document.edges.map(edge => ({
            from: edge.from,
            to: edge.to,
            type: edge.type,
            contract: edge.contractRef?.name,
            status: edge.status,
            source: edge.source,
            versionConstraint: edge.versionConstraint,
        })),
        suppressed: document.suppressed,
    };
}
/** Register the model-facing tools when the host provides a registry. */
export function apply(ctx) {
    // Direct property read: legal here because 'tools' is declared in inject
    // (plain-property fallback keeps direct-apply unit tests working).
    const tools = ctx.tools;
    if (tools === undefined)
        return;
    registerTool(tools, scanTool(ctx));
    registerTool(tools, graphTool(ctx));
    registerTool(tools, dispatchTool(ctx));
    registerTool(tools, clarifyTool(ctx));
    registerTool(tools, specTool(ctx));
    registerTool(tools, plansTool(ctx));
    registerTool(tools, executeTool(ctx));
    registerTool(tools, submitTool(ctx));
}
function scanTool(ctx) {
    return {
        name: 'repo_board_scan',
        description: '扫描一组本地代码仓库，构建/更新多仓关系图谱（构建依赖 + 契约提供方/消费方自动抽取）。' +
            '返回图的节点、边与抑制关系。图文件不存在时自动创建。',
        parameters: {
            type: 'object',
            properties: {
                project: { type: 'string', description: '仓库组名称，例如 acme-checkout' },
                graphPath: { type: 'string', description: '图 JSON 文件路径（不存在则创建）' },
                repos: {
                    type: 'array',
                    description: '要扫描的仓库列表',
                    items: {
                        type: 'object',
                        properties: {
                            key: { type: 'string', description: '稳定仓库名（图谱中的 id）' },
                            path: { type: 'string', description: '本地 checkout 路径' },
                        },
                        required: ['key', 'path'],
                        additionalProperties: false,
                    },
                },
            },
            required: ['project', 'graphPath', 'repos'],
            additionalProperties: false,
        },
        output: { schema: { type: 'object' }, render: textRender },
        async execute(args) {
            const input = asObject(args, 'arguments');
            const repos = Array.isArray(input['repos']) ? input['repos'] : fail('repos must be an array');
            const parsedRepos = repos.map(repo => {
                const item = asObject(repo, 'repos[]');
                return { key: asString(item['key'], 'repos[].key'), path: asString(item['path'], 'repos[].path') };
            });
            if (parsedRepos.length === 0)
                fail('repos must not be empty');
            const board = ctx.repoBoard;
            await board.open(asString(input['project'], 'project'), asString(input['graphPath'], 'graphPath'));
            const document = await board.scan(parsedRepos);
            return summarizeGraph(document);
        },
    };
}
function graphTool(ctx) {
    return {
        name: 'repo_board_graph',
        description: '查询当前多仓关系图谱：document（全图）、impact（某仓库的反向影响面/爆炸半径）、' +
            'dependencies（某仓库的正向依赖）、topology（SCC 缩点后的执行顺序，上游在前）。',
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['document', 'impact', 'dependencies', 'topology'], description: '查询类型' },
                repo: { type: 'string', description: '目标仓库（impact/dependencies 必填）' },
                confirmedOnly: { type: 'boolean', description: '只统计已确认的边（默认也含候选）' },
            },
            required: ['action'],
            additionalProperties: false,
        },
        output: { schema: { type: 'object' }, render: textRender },
        async execute(args) {
            const input = asObject(args, 'arguments');
            const action = asString(input['action'], 'action');
            const options = input['confirmedOnly'] === true ? { confirmedOnly: true } : undefined;
            const board = ctx.repoBoard;
            if (action === 'document')
                return summarizeGraph(board.document);
            const repo = asString(input['repo'], 'repo');
            if (action === 'impact')
                return { repo, impact: board.impact(repo, options) };
            if (action === 'dependencies')
                return { repo, dependencies: board.dependencies(repo, options) };
            if (action === 'topology') {
                return {
                    units: board.topologicalUnits(undefined, options).map(unit => ({
                        repos: unit.repos,
                        depth: unit.depth,
                        hasContractCycle: unit.hasContractCycle,
                    })),
                };
            }
            fail('unknown action ' + action);
        },
    };
}
function dispatchTool(ctx) {
    return {
        name: 'repo_board_dispatch',
        description: '登记一条多仓需求（一次下发的入口）。返回需求 id 与当前状态。' +
            '信息不足时先向用户追问（用你自己的提问机制），再用 repo_board_clarify 记录问题与回答，' +
            '然后通过 repo_board_spec 提交完整规格。',
        parameters: {
            type: 'object',
            properties: {
                text: { type: 'string', description: '需求原文' },
                candidateRepos: { type: 'array', items: { type: 'string' }, description: '可选：目标仓提示' },
                allowBreaking: { type: 'boolean', description: '可选：是否允许破坏性契约变更' },
                priority: { type: 'string', enum: ['low', 'normal', 'high'], description: '可选：优先级' },
            },
            required: ['text'],
            additionalProperties: false,
        },
        output: { schema: { type: 'object' }, render: textRender },
        async execute(args) {
            const input = asObject(args, 'arguments');
            const hint = {};
            if (input['candidateRepos'] !== undefined)
                hint['candidateRepos'] = asStringArray(input['candidateRepos'], 'candidateRepos');
            if (input['allowBreaking'] !== undefined)
                hint['allowBreaking'] = asBoolean(input['allowBreaking'], 'allowBreaking');
            if (input['priority'] !== undefined) {
                const priority = asString(input['priority'], 'priority');
                if (priority !== 'low' && priority !== 'normal' && priority !== 'high')
                    fail('priority must be low, normal, or high');
                hint['priority'] = priority;
            }
            const board = ctx.repoBoard;
            const { id, record } = await board.createRequirement({
                text: asString(input['text'], 'text'),
                hint: Object.keys(hint).length === 0 ? undefined : hint,
            });
            return {
                requirementId: id,
                status: record.status,
                next: '信息充分则调用 repo_board_spec 提交规格；信息不足则先向用户追问，' +
                    '再用 repo_board_clarify 记录，最后提交规格。规格必须包含 candidateRepos。',
            };
        },
    };
}
function clarifyTool(ctx) {
    return {
        name: 'repo_board_clarify',
        description: '记录一次需求澄清批次（[0] 追问闸门）：登记你向用户提出的问题与收到的回答。' +
            '阻断级问题必须全部有回答，规格才能挂载。questions 的 kind 为 select/multi-select/input/confirm。',
        parameters: {
            type: 'object',
            properties: {
                requirementId: { type: 'string', description: '需求 id' },
                questions: {
                    type: 'array',
                    description: '本轮问题',
                    items: {
                        type: 'object',
                        properties: {
                            id: { type: 'string' },
                            text: { type: 'string' },
                            kind: { type: 'string', enum: ['select', 'multi-select', 'input', 'confirm'] },
                            options: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    properties: {
                                        label: { type: 'string' },
                                        description: { type: 'string' },
                                        recommended: { type: 'boolean' },
                                    },
                                    required: ['label'],
                                    additionalProperties: false,
                                },
                            },
                            default: { type: 'string' },
                            blocking: { type: 'boolean' },
                            context: { type: 'string', description: '生成该问题的图谱依据' },
                        },
                        required: ['id', 'text', 'kind'],
                        additionalProperties: false,
                    },
                },
                answers: {
                    type: 'object',
                    description: '问题 id 到回答的映射（可分批提交）',
                },
            },
            required: ['requirementId', 'questions'],
            additionalProperties: false,
        },
        output: { schema: { type: 'object' }, render: textRender },
        async execute(args) {
            const input = asObject(args, 'arguments');
            const id = asString(input['requirementId'], 'requirementId');
            const questions = parseQuestions(input['questions']);
            const board = ctx.repoBoard;
            const record = board.getRequirement(id);
            if (record === undefined)
                fail('unknown requirement ' + id);
            const withQuestions = record.beginClarification(questions);
            const updated = input['answers'] === undefined
                ? withQuestions
                : withQuestions.resolveClarification(parseAnswers(input['answers']));
            await board.setRequirement(id, updated);
            const session = updated.toDocument().clarification;
            const blocking = questions.filter(question => question.blocking);
            const answered = blocking.filter(question => (session.answers?.[question.id] ?? '') !== '');
            return {
                requirementId: id,
                status: updated.status,
                blockingAnswered: answered.length + '/' + blocking.length,
                next: answered.length === blocking.length
                    ? '阻断级问题已全部回答，可调用 repo_board_spec。'
                    : '仍有阻断级问题未回答；继续追问用户后补充 answers。',
            };
        },
    };
}
function specTool(ctx) {
    return {
        name: 'repo_board_spec',
        description: '提交完整需求规格（[0]+[1]），自动完成影响面分析（[2]）并生成各仓方案骨架（[3] 草稿）。' +
            '返回 ImpactAnalysis（影响仓、执行顺序、关键契约边、未知仓）与待填充的方案骨架。' +
            '你基于骨架填写每仓的 summary/changes/writeScopes/breaking 后调用 repo_board_plans。',
        parameters: {
            type: 'object',
            properties: {
                requirementId: { type: 'string', description: '需求 id' },
                spec: {
                    type: 'object',
                    properties: {
                        text: { type: 'string', description: '原始需求 + 澄清决策的合并描述' },
                        goals: { type: 'array', items: { type: 'string' }, description: '拆出的子目标' },
                        candidateRepos: { type: 'array', items: { type: 'string' }, description: '直接涉及的仓' },
                        constraints: { type: 'array', items: { type: 'string' }, description: '破坏性/兼容/时间约束' },
                        acceptance: { type: 'array', items: { type: 'string' }, description: '验收标准' },
                    },
                    required: ['text', 'candidateRepos'],
                    additionalProperties: false,
                },
            },
            required: ['requirementId', 'spec'],
            additionalProperties: false,
        },
        output: { schema: { type: 'object' }, render: textRender },
        async execute(args) {
            const input = asObject(args, 'arguments');
            const id = asString(input['requirementId'], 'requirementId');
            const spec = parseSpec(input['spec']);
            const board = ctx.repoBoard;
            const record = board.getRequirement(id);
            if (record === undefined)
                fail('unknown requirement ' + id);
            const analyzed = record.attachSpec(spec).analyze(board.document);
            const skeletons = scaffoldPlans(board.document, analyzed.analysis, spec);
            await board.setRequirement(id, analyzed);
            return {
                requirementId: id,
                status: analyzed.status,
                analysis: analyzed.analysis,
                planSkeletons: skeletons,
                next: '填写每仓方案的 summary/changes/writeScopes/contractImpact.breaking（prerequisites 已由图谱推导，' +
                    '不要改动），然后调用 repo_board_plans 挂载并获取评审发现。',
            };
        },
    };
}
function plansTool(ctx) {
    return {
        name: 'repo_board_plans',
        description: '挂载填好的各仓修改方案（[3]）并生成人审发现（[4]）：写范围冲突、声明为破坏性的契约变更、关键契约边。' +
            '方案仓库必须在影响面内；prerequisites 必须指向有方案的仓库。返回执行顺序与评审发现。',
        parameters: {
            type: 'object',
            properties: {
                requirementId: { type: 'string', description: '需求 id' },
                plans: {
                    type: 'array',
                    description: '各仓修改方案（从 repo_board_spec 返回的骨架填充而来）',
                    items: {
                        type: 'object',
                        properties: {
                            repo: { type: 'string' },
                            summary: { type: 'string' },
                            changes: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    properties: { target: { type: 'string' }, description: { type: 'string' } },
                                    required: ['target', 'description'],
                                    additionalProperties: false,
                                },
                            },
                            writeScopes: { type: 'array', items: { type: 'string' } },
                            contractImpact: {
                                type: 'object',
                                properties: {
                                    breaking: { type: 'array', items: { type: 'string' } },
                                    downstream: { type: 'array' },
                                },
                                additionalProperties: false,
                            },
                            prerequisites: { type: 'array', items: { type: 'string' } },
                            acceptance: { type: 'array', items: { type: 'string' } },
                        },
                        required: ['repo', 'summary'],
                        additionalProperties: false,
                    },
                },
            },
            required: ['requirementId', 'plans'],
            additionalProperties: false,
        },
        output: { schema: { type: 'object' }, render: textRender },
        async execute(args) {
            const input = asObject(args, 'arguments');
            const id = asString(input['requirementId'], 'requirementId');
            const rawPlans = Array.isArray(input['plans']) ? input['plans'] : fail('plans must be an array');
            const plans = rawPlans.map(plan => parsePlan(plan));
            const board = ctx.repoBoard;
            const record = board.getRequirement(id);
            if (record === undefined)
                fail('unknown requirement ' + id);
            const planned = record.attachPlans(plans);
            const findings = reviewFindings(board.document, planned.toDocument().analysis, plans);
            await board.setRequirement(id, planned);
            return {
                requirementId: id,
                status: planned.status,
                findings,
                executionOrder: planned
                    .toDocument()
                    .analysis.topologicalOrder.filter(unit => plans.some(plan => unit.repos.includes(plan.repo)))
                    .map(unit => ({ repos: unit.repos, depth: unit.depth })),
                next: findings.conflicts.length > 0 || findings.breakingChanges.length > 0
                    ? '存在需要人审的发现；向用户确认后调用 repo_board_execute。'
                    : '无阻断发现，可调用 repo_board_execute 执行。',
            };
        },
    };
}
function executeTool(ctx) {
    return {
        name: 'repo_board_execute',
        description: '执行已挂载方案的多仓修改（[5]-[6]）：按依赖顺序（上游先行）为每个仓库启动一个独立子代理会话，' +
            '会话在对应仓库内完成修改。commitPolicy=auto（默认）时会话自行提交；manual 时调度方先切需求分支' +
            '（ai-delivery/<需求id>/<仓>），会话只改不提交，改完停在 submit-pending 等人工确认（用 repo_board_submit）。' +
            '失败仓可按 maxAttempts 重试（带失败历史重新执行），仍失败则阻断下游仓。返回每个仓的执行状态。',
        parameters: {
            type: 'object',
            properties: {
                requirementId: { type: 'string', description: '需求 id' },
                concurrency: { type: 'integer', description: '同批次并行上限（默认整批并行）' },
                commitPolicy: { type: 'string', description: 'auto=会话自行提交（默认）；manual=人工确认后才提交', enum: ['auto', 'manual'] },
                maxAttempts: { type: 'integer', description: '每仓最大尝试次数（默认 1；重试会带上失败历史）' },
            },
            required: ['requirementId'],
            additionalProperties: false,
        },
        output: { schema: { type: 'object' }, render: textRender },
        timeoutMs: 3_600_000,
        async execute(args, exec) {
            const input = asObject(args, 'arguments');
            const id = asString(input['requirementId'], 'requirementId');
            const concurrency = input['concurrency'] === undefined ? undefined : Number(input['concurrency']);
            const commitPolicy = input['commitPolicy'] === 'manual' ? 'manual' : 'auto';
            const maxAttempts = input['maxAttempts'] === undefined ? undefined : Math.max(1, Number(input['maxAttempts']));
            const board = ctx.repoBoard;
            const record = board.getRequirement(id);
            if (record === undefined)
                fail('unknown requirement ' + id);
            const document = record.toDocument();
            if (document.spec === undefined)
                fail('requirement has no spec');
            // Probe the subagent service at execute time (optional host service:
            // ctx.get never throws on real cordis, unlike undeclared property reads).
            const { subagents } = hostCapabilities(ctx);
            if (subagents === undefined)
                fail('this host provides no subagent runtime - cannot execute one-session-per-repo');
            if (exec.agent === undefined)
                fail('no calling agent - cannot parent repo sessions');
            const task = buildRepoSessionTask({
                subagents,
                parent: exec.agent,
                spec: document.spec,
                upstream: { results: [] },
                signal: exec.signal,
                selfCommit: commitPolicy === 'auto',
            });
            const git = commitPolicy === 'manual' ? new GitClient(new NodeCommandRunner()) : undefined;
            const { record: dispatched, run } = await board.dispatchRequirement(record, task, {
                concurrency,
                git,
                commitPolicy,
                maxAttempts,
            });
            await board.setRequirement(id, dispatched);
            const pending = run.perRepo.filter(entry => entry.state === 'submit-pending');
            return {
                requirementId: id,
                status: dispatched.status,
                run,
                narration: renderRunLine(run),
                next: pending.length > 0
                    ? '有仓停在 submit-pending：' + pending.map(entry => entry.repo).join(', ') + '。请向用户展示改动清单，确认后调用 repo_board_submit（approve），拒绝则 decision=reject。'
                    : undefined,
            };
        },
    };
}
function submitTool(ctx) {
    return {
        name: 'repo_board_submit',
        description: '人工提交确认（提交门控）：对停在 submit-pending 的仓做放行或拒绝。approve=调度方在需求分支上提交该仓改动' +
            '（状态变 submitted，返回 commit）；reject=不提交、状态变 needs-human 并记录原因。只有 submit-pending 的仓可操作。',
        parameters: {
            type: 'object',
            properties: {
                requirementId: { type: 'string', description: '需求 id' },
                repo: { type: 'string', description: '仓库名' },
                decision: { type: 'string', description: 'approve=确认提交；reject=拒绝提交', enum: ['approve', 'reject'] },
                message: { type: 'string', description: 'approve 时的提交信息（可选，默认用方案摘要）；reject 时的拒绝原因' },
            },
            required: ['requirementId', 'repo', 'decision'],
            additionalProperties: false,
        },
        output: { schema: { type: 'object' }, render: textRender },
        async execute(args) {
            const input = asObject(args, 'arguments');
            const id = asString(input['requirementId'], 'requirementId');
            const repo = asString(input['repo'], 'repo');
            const decision = asString(input['decision'], 'decision');
            if (decision !== 'approve' && decision !== 'reject')
                fail('decision must be approve or reject');
            const message = typeof input['message'] === 'string' && input['message'] !== '' ? input['message'] : undefined;
            const board = ctx.repoBoard;
            const record = board.getRequirement(id);
            if (record === undefined)
                fail('unknown requirement ' + id);
            const next = decision === 'approve'
                ? await board.approveSubmit(record, repo, { message })
                : await board.rejectSubmit(record, repo, message);
            const run = next.toDocument().run;
            const entry = run.perRepo.find(item => item.repo === repo);
            return {
                requirementId: id,
                repo,
                decision,
                state: entry.state,
                commit: entry.commit,
                run,
            };
        },
    };
}
