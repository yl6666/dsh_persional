/**
 * Host web routes for the board UI (docs/product-design.md 7, 14.1).
 *
 * A separate cordis plugin consuming `ctx.repoBoard` plus the host's
 * optional web server (probed structurally, like the tools plugin). Two GET
 * routes serve the current graph and the requirement list; one POST route
 * carries the graph editor's mutation verbs back into the service. Route
 * handlers own the full response lifecycle per the web-server contract.
 * @module dsh-repo-board/web
 */
/** Cordis plugin name. */
export const name = 'repo-board-web';
/** The board service must be live before routes register. */
export const inject = ['repoBoard'];
function json(res, status, value) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
}
function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => { body += String(chunk); });
        req.on('end', () => { resolve(body); });
        req.on('error', reject);
    });
}
const EDGE_ACTIONS = ['add-manual-edge', 'confirm', 'suppress', 'remove'];
const EDGE_TYPES = ['build', 'code', 'contract', 'semantic'];
function parseEdgeAction(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new Error('请求体不是合法 JSON');
    }
    if (typeof parsed !== 'object' || parsed === null)
        throw new Error('请求体必须是对象');
    const input = parsed;
    const action = input['action'];
    if (typeof action !== 'string' || !EDGE_ACTIONS.includes(action)) {
        throw new Error('action 必须是 ' + EDGE_ACTIONS.join('/') + ' 之一');
    }
    // Shape validation happens before the isOpen gate: a malformed request is
    // 400 regardless of whether a graph is open.
    if (action === 'add-manual-edge') {
        for (const key of ['from', 'to', 'type']) {
            if (typeof input[key] !== 'string' || input[key] === '')
                throw new Error(key + ' 必须是非空字符串');
        }
    }
    else if (typeof input['id'] !== 'string' || input['id'] === '') {
        throw new Error('id 必须是非空字符串');
    }
    return input;
}
function requireString(input, key) {
    const value = input[key];
    if (typeof value !== 'string' || value === '')
        throw new Error(key + ' 必须是非空字符串');
    return value;
}
/** Register the board routes when the host provides a web server. */
export function apply(ctx) {
    const board = ctx.repoBoard;
    const webServer = ctx.webServer;
    if (board === undefined || webServer === undefined)
        return;
    webServer.register({
        kind: 'exact',
        path: '/repo-board/graph.json',
        handler: (_req, res) => {
            if (!board.isOpen) {
                json(res, 404, { error: '尚未打开任何图——先在会话中调用 repo_board_scan' });
                return;
            }
            json(res, 200, board.document);
        },
    });
    webServer.register({
        kind: 'exact',
        path: '/repo-board/requirements.json',
        handler: (_req, res) => {
            json(res, 200, board.listRequirements().map(document => ({
                id: document.id,
                status: document.status,
                text: document.draft.text,
            })));
        },
    });
    webServer.register({
        kind: 'exact',
        path: '/repo-board/edges',
        handler: async (req, res) => {
            if (req.method !== 'POST') {
                json(res, 405, { error: '只接受 POST' });
                return;
            }
            let input;
            try {
                input = parseEdgeAction(await readBody(req));
            }
            catch (error) {
                json(res, 400, { error: error instanceof Error ? error.message : String(error) });
                return;
            }
            if (!board.isOpen) {
                json(res, 409, { error: '尚未打开任何图' });
                return;
            }
            try {
                if (input.action === 'add-manual-edge') {
                    const type = requireString(input, 'type');
                    if (!EDGE_TYPES.includes(type))
                        throw new Error('type 必须是 ' + EDGE_TYPES.join('/') + ' 之一');
                    const contractName = typeof input['contractName'] === 'string' && input['contractName'] !== ''
                        ? input['contractName']
                        : undefined;
                    const contractKind = typeof input['contractKind'] === 'string' && input['contractKind'] !== ''
                        ? input['contractKind']
                        : undefined;
                    await board.addManualEdge({
                        from: requireString(input, 'from'),
                        to: requireString(input, 'to'),
                        type,
                        contractRef: contractName === undefined
                            ? undefined
                            : { kind: (contractKind ?? 'other'), name: contractName },
                    });
                }
                else {
                    const id = requireString(input, 'id');
                    // The store treats unknown ids as no-ops (merge semantics); a stale
                    // UI id deserves an explicit 422. Remove stays idempotent.
                    if (input.action !== 'remove' && !board.document.edges.some(edge => edge.id === id)) {
                        throw new Error('边不存在：' + id);
                    }
                    if (input.action === 'confirm')
                        await board.confirmEdge(id);
                    else if (input.action === 'suppress')
                        await board.suppressEdge(id, 'board UI 手动抑制');
                    else
                        await board.removeEdge(id);
                }
                json(res, 200, board.document);
            }
            catch (error) {
                json(res, 422, { error: error instanceof Error ? error.message : String(error) });
            }
        },
    });
}
