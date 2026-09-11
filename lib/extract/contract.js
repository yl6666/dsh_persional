/**
 * Contract extractor - the second tier of the extraction pipeline
 * (docs/product-design.md 4.1 L3, 4.3).
 *
 * Deterministic, no LLM: locate contract-bearing files (OpenAPI/Swagger,
 * AsyncAPI, protobuf, GraphQL, JSON Schema, event registry files), extract
 * the contracts one repo PROVIDES, then resolve CONSUMERS by searching other
 * repos' source files for the contract token. Consumer edges point from the
 * consumer to the provider (direction convention, types.ts).
 * @module dsh-repo-board
 */
/** Files whose content is never searched for contract references. */
const NON_SOURCE_SUFFIXES = [
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'go.sum',
    'poetry.lock',
    'Cargo.lock',
    'composer.lock',
    'Gemfile.lock',
    '.min.js',
    '.map',
];
function isSearchableFile(path) {
    return !NON_SOURCE_SUFFIXES.some(suffix => path.endsWith(suffix));
}
/** Does this path carry a contract declaration? */
export function isContractFile(path) {
    const base = path.split('/').pop() ?? path;
    if (base === 'openapi.yaml' || base === 'openapi.yml' || base === 'openapi.json' ||
        base === 'swagger.yaml' || base === 'swagger.yml' || base === 'swagger.json' ||
        base === 'asyncapi.yaml' || base === 'asyncapi.yml' || base === 'asyncapi.json')
        return true;
    if (/\.openapi\.ya?ml$/.test(path) || /\.swagger\.ya?ml$/.test(path))
        return true;
    if (/\.proto$/.test(path))
        return true;
    if (/\.graphqls?$/.test(path))
        return true;
    if (/\.schema\.json$/.test(path))
        return true;
    if (/^events\/[^/]+\.(json|ya?ml)$/.test(path))
        return true;
    if (/\.event\.(json|ya?ml)$/.test(path))
        return true;
    if (/^schemas\/[^/]+\.json$/.test(path))
        return true;
    return false;
}
function indentOf(line) {
    let i = 0;
    while (i < line.length && line[i] === ' ')
        i++;
    return i;
}
function stripQuotes(text) {
    return text.replace(/^['"]/, '').replace(/['"]$/, '');
}
/** OpenAPI/AsyncAPI YAML: 2-space paths:/channels: keys plus operationIds. */
function parseSpecYaml(content, entryKind, innerKind) {
    const contracts = [];
    const lines = content.replace(/\t/g, '  ').split('\n');
    let inEntry = false;
    let currentKey;
    for (const rawLine of lines) {
        const line = rawLine.replace(/\s+$/, '');
        if (line === entryKind + ':') {
            inEntry = true;
            currentKey = undefined;
            continue;
        }
        if (!inEntry)
            continue;
        if (line.trim() === '')
            continue;
        const indent = indentOf(line);
        if (indent === 0) {
            inEntry = false;
            continue;
        }
        if (indent === 2) {
            const match = /^(\S+):\s*(.*)$/.exec(line.trim());
            if (match !== null) {
                currentKey = stripQuotes(match[1]);
                contracts.push({ kind: entryKind === 'paths' ? 'api' : 'topic', name: currentKey });
            }
            continue;
        }
        if (innerKind === 'api') {
            const op = /^\s*operationId:\s*(\S+)\s*$/.exec(line);
            if (op !== null && currentKey !== undefined)
                contracts.push({ kind: 'api', name: op[1] });
        }
    }
    return contracts;
}
/** OpenAPI JSON: path keys plus operationIds. */
function parseOpenApiJson(content) {
    const json = JSON.parse(content);
    const contracts = [];
    const paths = json.paths;
    if (typeof paths === 'object' && paths !== null) {
        for (const [path, item] of Object.entries(paths)) {
            contracts.push({ kind: 'api', name: path });
            if (typeof item !== 'object' || item === null)
                continue;
            for (const op of Object.values(item)) {
                if (typeof op !== 'object' || op === null)
                    continue;
                const operationId = op.operationId;
                if (typeof operationId === 'string' && operationId !== '') {
                    contracts.push({ kind: 'api', name: operationId });
                }
            }
        }
    }
    return contracts;
}
/** protobuf: services become rpc contracts, messages become schema contracts, in file order. */
function parseProto(content) {
    const contracts = [];
    for (const match of content.matchAll(/^\s*(service|message)\s+(\w+)\s*\{/gm)) {
        contracts.push(match[1] === 'service' ? { kind: 'rpc', name: match[2] } : { kind: 'schema', name: match[2] });
    }
    return contracts;
}
const rootOperationTypes = ['Query', 'Mutation', 'Subscription'];
/** GraphQL SDL: root operation fields become api contracts, other types become schema contracts. */
function parseGraphql(content) {
    const contracts = [];
    const lines = content.split('\n');
    let currentType;
    for (const rawLine of lines) {
        const typeMatch = /^\s*(?:type|interface|input|enum)\s+(\w+)(?:\s+implements\s+[\w\s,&]+)?\s*\{/.exec(rawLine);
        if (typeMatch !== null) {
            currentType = typeMatch[1];
            if (!rootOperationTypes.includes(currentType)) {
                contracts.push({ kind: 'schema', name: currentType });
            }
            continue;
        }
        if (currentType === undefined)
            continue;
        if (/^\s*\}/.test(rawLine)) {
            currentType = undefined;
            continue;
        }
        if (currentType === 'Query' || currentType === 'Mutation' || currentType === 'Subscription') {
            const field = /^\s+(\w+)\s*[:(]/.exec(rawLine);
            if (field !== null)
                contracts.push({ kind: 'api', name: field[1] });
        }
    }
    return contracts;
}
/** JSON Schema: title, $id, or name becomes the contract name. */
function parseSchemaJson(content, fallbackName) {
    const json = JSON.parse(content);
    for (const field of ['title', '$id', 'name']) {
        const value = json[field];
        if (typeof value === 'string' && value !== '')
            return [{ kind: 'schema', name: value }];
    }
    return [{ kind: 'schema', name: fallbackName }];
}
/** Event registry files: `name` or `topic` becomes an event contract. */
function parseEventFile(content, isJson) {
    if (isJson) {
        const json = JSON.parse(content);
        for (const field of ['name', 'topic']) {
            const value = json[field];
            if (typeof value === 'string' && value !== '')
                return [{ kind: 'event', name: value }];
        }
        return [];
    }
    for (const field of ['name', 'topic']) {
        const match = new RegExp("^" + field + ":\\s*['\"]?([^\\s'\"]+)", 'm').exec(content);
        if (match !== null)
            return [{ kind: 'event', name: match[1] }];
    }
    return [];
}
function parseContractFile(path, content) {
    const base = path.split('/').pop() ?? path;
    const isJson = /\.json$/.test(path);
    if (/\.proto$/.test(path))
        return parseProto(content);
    if (/\.graphqls?$/.test(path))
        return parseGraphql(content);
    if (/\.schema\.json$/.test(path))
        return parseSchemaJson(content, base.replace(/\.schema\.json$/, ''));
    if (/^events\//.test(path) || /\.event\.(json|ya?ml)$/.test(path))
        return parseEventFile(content, isJson);
    if (/^schemas\//.test(path) && isJson)
        return parseSchemaJson(content, base.replace(/\.json$/, ''));
    if (base.startsWith('asyncapi') || /\.asyncapi\.ya?ml$/.test(path)) {
        return parseSpecYaml(content, 'channels', 'topic');
    }
    if (isJson)
        return parseOpenApiJson(content);
    return parseSpecYaml(content, 'paths', 'api');
}
/**
 * Extract the contracts one repo PROVIDES from its files. Only files passing
 * {@link isContractFile} are consumed; within one repo a (kind, name) pair
 * deduplicates to its first declaration.
 */
export function extractProvidedContracts(repo, files) {
    const seen = new Set();
    const contracts = [];
    for (const [path, content] of Object.entries(files)) {
        if (!isContractFile(path))
            continue;
        for (const parsed of parseContractFile(path, content)) {
            const key = parsed.kind + '::' + parsed.name;
            if (seen.has(key))
                continue;
            seen.add(key);
            contracts.push({ kind: parsed.kind, name: parsed.name, file: path });
        }
    }
    return contracts;
}
function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/** A contract token matches only at identifier-like boundaries. */
function nameTokenRegex(name) {
    return new RegExp('(?<![\\w.-])' + escapeRegExp(name) + '(?![\\w.-])');
}
/**
 * Resolve contract consumers into contract edges (consumer -> provider).
 * A repo consumes a contract when a searchable file references the contract
 * token at identifier boundaries. Providers of the same (kind, name) are
 * treated as duplicate declarations, not consumers.
 */
export function resolveContractConsumers(input) {
    const providerByKey = new Map();
    for (const [repo, contracts] of input.contracts) {
        for (const contract of contracts) {
            providerByKey.set(contract.kind + '::' + contract.name, repo);
        }
    }
    const edges = new Map();
    for (const [provider, contracts] of input.contracts) {
        for (const contract of contracts) {
            const token = nameTokenRegex(contract.name);
            for (const [consumer, files] of Object.entries(input.files)) {
                if (consumer === provider)
                    continue;
                const consumerContracts = input.contracts.get(consumer);
                if (consumerContracts !== undefined && consumerContracts.some(c => c.kind === contract.kind && c.name === contract.name))
                    continue;
                let hit = false;
                for (const [path, content] of Object.entries(files)) {
                    if (!isSearchableFile(path))
                        continue;
                    if (token.test(content)) {
                        hit = true;
                        break;
                    }
                }
                if (!hit)
                    continue;
                const edge = {
                    from: consumer,
                    to: provider,
                    type: 'contract',
                    contractRef: { kind: contract.kind, name: contract.name },
                    strength: 0.9,
                };
                edges.set(edge.from + '->' + edge.to + '::' + contract.name, edge);
            }
        }
    }
    return [...edges.values()].sort((a, b) => (a.from + '->' + a.to + '::' + (a.contractRef?.name ?? '')).localeCompare(b.from + '->' + b.to + '::' + (b.contractRef?.name ?? '')));
}
