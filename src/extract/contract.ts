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

import type { AutoEdgeInput } from '../graph/store.ts'
import type { ContractKind } from '../graph/types.ts'

/** One contract a repo provides. */
export interface ContractDeclaration {
  readonly kind: ContractKind
  readonly name: string
  readonly file: string
}

/** One (kind, name) pair produced by a file parser. */
interface ParsedContract {
  readonly kind: ContractKind
  readonly name: string
}

/** Files whose content is never searched for contract references. */
const NON_SOURCE_SUFFIXES: readonly string[] = [
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
]

function isSearchableFile(path: string): boolean {
  return !NON_SOURCE_SUFFIXES.some(suffix => path.endsWith(suffix))
}

/** Does this path carry a contract declaration? */
export function isContractFile(path: string): boolean {
  const base = path.split('/').pop() ?? path
  if (
    base === 'openapi.yaml' || base === 'openapi.yml' || base === 'openapi.json' ||
    base === 'swagger.yaml' || base === 'swagger.yml' || base === 'swagger.json' ||
    base === 'asyncapi.yaml' || base === 'asyncapi.yml' || base === 'asyncapi.json'
  ) return true
  if (/\.openapi\.ya?ml$/.test(path) || /\.swagger\.ya?ml$/.test(path)) return true
  if (/\.proto$/.test(path)) return true
  if (/\.graphqls?$/.test(path)) return true
  if (/\.schema\.json$/.test(path)) return true
  if (/^events\/[^/]+\.(json|ya?ml)$/.test(path)) return true
  if (/\.event\.(json|ya?ml)$/.test(path)) return true
  if (/^schemas\/[^/]+\.json$/.test(path)) return true
  return false
}

function indentOf(line: string): number {
  let i = 0
  while (i < line.length && line[i] === ' ') i++
  return i
}

function stripQuotes(text: string): string {
  return text.replace(/^['"]/, '').replace(/['"]$/, '')
}

/** OpenAPI/AsyncAPI YAML: 2-space paths:/channels: keys plus operationIds. */
function parseSpecYaml(content: string, entryKind: 'paths' | 'channels', innerKind: ContractKind): ParsedContract[] {
  const contracts: ParsedContract[] = []
  const lines = content.replace(/\t/g, '  ').split('\n')
  let inEntry = false
  let currentKey: string | undefined
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '')
    if (line === entryKind + ':') {
      inEntry = true
      currentKey = undefined
      continue
    }
    if (!inEntry) continue
    if (line.trim() === '') continue
    const indent = indentOf(line)
    if (indent === 0) {
      inEntry = false
      continue
    }
    if (indent === 2) {
      const match = /^(\S+):\s*(.*)$/.exec(line.trim())
      if (match !== null) {
        currentKey = stripQuotes(match[1]!)
        contracts.push({ kind: entryKind === 'paths' ? 'api' : 'topic', name: currentKey })
      }
      continue
    }
    if (innerKind === 'api') {
      const op = /^\s*operationId:\s*(\S+)\s*$/.exec(line)
      if (op !== null && currentKey !== undefined) contracts.push({ kind: 'api', name: op[1]! })
    }
  }
  return contracts
}

interface OpenApiJson {
  readonly paths?: unknown
}

/** OpenAPI JSON: path keys plus operationIds. */
function parseOpenApiJson(content: string): ParsedContract[] {
  const json = JSON.parse(content) as OpenApiJson
  const contracts: ParsedContract[] = []
  const paths = json.paths
  if (typeof paths === 'object' && paths !== null) {
    for (const [path, item] of Object.entries(paths as Record<string, unknown>)) {
      contracts.push({ kind: 'api', name: path })
      if (typeof item !== 'object' || item === null) continue
      for (const op of Object.values(item as Record<string, unknown>)) {
        if (typeof op !== 'object' || op === null) continue
        const operationId = (op as { readonly operationId?: unknown }).operationId
        if (typeof operationId === 'string' && operationId !== '') {
          contracts.push({ kind: 'api', name: operationId })
        }
      }
    }
  }
  return contracts
}

/** protobuf: services become rpc contracts, messages become schema contracts, in file order. */
function parseProto(content: string): ParsedContract[] {
  const contracts: ParsedContract[] = []
  for (const match of content.matchAll(/^\s*(service|message)\s+(\w+)\s*\{/gm)) {
    contracts.push(match[1] === 'service' ? { kind: 'rpc', name: match[2]! } : { kind: 'schema', name: match[2]! })
  }
  return contracts
}

const rootOperationTypes: readonly string[] = ['Query', 'Mutation', 'Subscription']

/** GraphQL SDL: root operation fields become api contracts, other types become schema contracts. */
function parseGraphql(content: string): ParsedContract[] {
  const contracts: ParsedContract[] = []
  const lines = content.split('\n')
  let currentType: string | undefined
  for (const rawLine of lines) {
    const typeMatch = /^\s*(?:type|interface|input|enum)\s+(\w+)(?:\s+implements\s+[\w\s,&]+)?\s*\{/.exec(rawLine)
    if (typeMatch !== null) {
      currentType = typeMatch[1]!
      if (!rootOperationTypes.includes(currentType)) {
        contracts.push({ kind: 'schema', name: currentType })
      }
      continue
    }
    if (currentType === undefined) continue
    if (/^\s*\}/.test(rawLine)) {
      currentType = undefined
      continue
    }
    if (currentType === 'Query' || currentType === 'Mutation' || currentType === 'Subscription') {
      const field = /^\s+(\w+)\s*[:(]/.exec(rawLine)
      if (field !== null) contracts.push({ kind: 'api', name: field[1]! })
    }
  }
  return contracts
}

interface SchemaJson {
  readonly title?: unknown
  readonly $id?: unknown
  readonly name?: unknown
  readonly topic?: unknown
}

/** JSON Schema: title, $id, or name becomes the contract name. */
function parseSchemaJson(content: string, fallbackName: string): ParsedContract[] {
  const json = JSON.parse(content) as SchemaJson
  for (const field of ['title', '$id', 'name'] as const) {
    const value = json[field]
    if (typeof value === 'string' && value !== '') return [{ kind: 'schema', name: value }]
  }
  return [{ kind: 'schema', name: fallbackName }]
}

/** Event registry files: `name` or `topic` becomes an event contract. */
function parseEventFile(content: string, isJson: boolean): ParsedContract[] {
  if (isJson) {
    const json = JSON.parse(content) as SchemaJson
    for (const field of ['name', 'topic'] as const) {
      const value = json[field]
      if (typeof value === 'string' && value !== '') return [{ kind: 'event', name: value }]
    }
    return []
  }
  for (const field of ['name', 'topic'] as const) {
    const match = new RegExp("^" + field + ":\\s*['\"]?([^\\s'\"]+)", 'm').exec(content)
    if (match !== null) return [{ kind: 'event', name: match[1]! }]
  }
  return []
}

function parseContractFile(path: string, content: string): ParsedContract[] {
  const base = path.split('/').pop() ?? path
  const isJson = /\.json$/.test(path)
  if (/\.proto$/.test(path)) return parseProto(content)
  if (/\.graphqls?$/.test(path)) return parseGraphql(content)
  if (/\.schema\.json$/.test(path)) return parseSchemaJson(content, base.replace(/\.schema\.json$/, ''))
  if (/^events\//.test(path) || /\.event\.(json|ya?ml)$/.test(path)) return parseEventFile(content, isJson)
  if (/^schemas\//.test(path) && isJson) return parseSchemaJson(content, base.replace(/\.json$/, ''))
  if (base.startsWith('asyncapi') || /\.asyncapi\.ya?ml$/.test(path)) {
    return parseSpecYaml(content, 'channels', 'topic')
  }
  if (isJson) return parseOpenApiJson(content)
  return parseSpecYaml(content, 'paths', 'api')
}

/**
 * Extract the contracts one repo PROVIDES from its files. Only files passing
 * {@link isContractFile} are consumed; within one repo a (kind, name) pair
 * deduplicates to its first declaration.
 */
export function extractProvidedContracts(repo: string, files: Readonly<Record<string, string>>): ContractDeclaration[] {
  const seen = new Set<string>()
  const contracts: ContractDeclaration[] = []
  for (const [path, content] of Object.entries(files)) {
    if (!isContractFile(path)) continue
    for (const parsed of parseContractFile(path, content)) {
      const key = parsed.kind + '::' + parsed.name
      if (seen.has(key)) continue
      seen.add(key)
      contracts.push({ kind: parsed.kind, name: parsed.name, file: path })
    }
  }
  return contracts
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A contract token matches only at identifier-like boundaries. */
function nameTokenRegex(name: string): RegExp {
  return new RegExp('(?<![\\w.-])' + escapeRegExp(name) + '(?![\\w.-])')
}

export interface ContractResolutionInput {
  /** Provider repo -> contracts it provides. */
  readonly contracts: ReadonlyMap<string, readonly ContractDeclaration[]>
  /** Every repo's searchable files (path -> content). */
  readonly files: Readonly<Record<string, Readonly<Record<string, string>>>>
}

/**
 * Resolve contract consumers into contract edges (consumer -> provider).
 * A repo consumes a contract when a searchable file references the contract
 * token at identifier boundaries. Providers of the same (kind, name) are
 * treated as duplicate declarations, not consumers.
 */
export function resolveContractConsumers(input: ContractResolutionInput): AutoEdgeInput[] {
  const providerByKey = new Map<string, string>()
  for (const [repo, contracts] of input.contracts) {
    for (const contract of contracts) {
      providerByKey.set(contract.kind + '::' + contract.name, repo)
    }
  }
  const edges = new Map<string, AutoEdgeInput>()
  for (const [provider, contracts] of input.contracts) {
    for (const contract of contracts) {
      const token = nameTokenRegex(contract.name)
      for (const [consumer, files] of Object.entries(input.files)) {
        if (consumer === provider) continue
        const consumerContracts = input.contracts.get(consumer)
        if (consumerContracts !== undefined && consumerContracts.some(c => c.kind === contract.kind && c.name === contract.name)) continue
        let hit = false
        for (const [path, content] of Object.entries(files)) {
          if (!isSearchableFile(path)) continue
          if (token.test(content)) {
            hit = true
            break
          }
        }
        if (!hit) continue
        const edge: AutoEdgeInput = {
          from: consumer,
          to: provider,
          type: 'contract',
          contractRef: { kind: contract.kind, name: contract.name },
          strength: 0.9,
        }
        edges.set(edge.from + '->' + edge.to + '::' + contract.name, edge)
      }
    }
  }
  return [...edges.values()].sort((a, b) =>
    (a.from + '->' + a.to + '::' + (a.contractRef?.name ?? '')).localeCompare(
      b.from + '->' + b.to + '::' + (b.contractRef?.name ?? ''),
    ),
  )
}
