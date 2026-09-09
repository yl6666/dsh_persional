import { describe, expect, it } from 'vitest'
import {
  extractProvidedContracts,
  isContractFile,
  resolveContractConsumers,
} from '../src/extract/contract.ts'
import type { ContractDeclaration } from '../src/extract/contract.ts'

function contractMap(entries: readonly (readonly [string, readonly ContractDeclaration[]])[]) {
  return new Map<string, readonly ContractDeclaration[]>(entries)
}

const openapiYaml = [
  'openapi: 3.1.0',
  'info:',
  '  title: Orders API',
  'paths:',
  '  /orders:',
  '    get:',
  '      operationId: listOrders',
  '      responses:',
  '        "200":',
  '          description: ok',
  '  /orders/{id}:',
  '    get:',
  '      operationId: getOrder',
].join('\n')

const protoFile = [
  'syntax = "proto3";',
  'package acme.orders;',
  '',
  'message OrderCancelled {',
  '  string order_id = 1;',
  '}',
  '',
  'service OrderService {',
  '  rpc CancelOrder (CancelRequest) returns (CancelResponse);',
  '}',
].join('\n')

const graphqlFile = [
  'type Order {',
  '  id: ID!',
  '  total: Int',
  '}',
  '',
  'type Query {',
  '  orders: [Order!]!',
  '  order(id: ID!): Order',
  '}',
].join('\n')

describe('isContractFile', () => {
  it('recognizes spec, proto, graphql, schema, and event files', () => {
    for (const path of [
      'openapi.yaml',
      'api/swagger.json',
      'specs/orders.openapi.yml',
      'proto/orders.proto',
      'schema/orders.graphql',
      'schema/orders.graphqls',
      'schemas/order.schema.json',
      'events/order-cancelled.json',
      'events/order-created.yaml',
      'asyncapi.yaml',
    ]) {
      expect(isContractFile(path), path).toBe(true)
    }
  })

  it('rejects ordinary source and lock files', () => {
    for (const path of ['src/index.ts', 'package.json', 'events/readme.md', 'schemas/notes.txt', 'orders.proto.bak']) {
      expect(isContractFile(path), path).toBe(false)
    }
  })
})

describe('extractProvidedContracts (provider side)', () => {
  it('extracts paths and operationIds from OpenAPI YAML', () => {
    const contracts = extractProvidedContracts('orders-api', { 'openapi.yaml': openapiYaml })
    expect(contracts).toEqual([
      { kind: 'api', name: '/orders', file: 'openapi.yaml' },
      { kind: 'api', name: 'listOrders', file: 'openapi.yaml' },
      { kind: 'api', name: '/orders/{id}', file: 'openapi.yaml' },
      { kind: 'api', name: 'getOrder', file: 'openapi.yaml' },
    ])
  })

  it('extracts paths and operationIds from OpenAPI JSON', () => {
    const contracts = extractProvidedContracts('orders-api', {
      'openapi.json': JSON.stringify({
        openapi: '3.0.0',
        paths: {
          '/orders': { get: { operationId: 'listOrders' }, post: { operationId: 'createOrder' } },
        },
      }),
    })
    expect(contracts).toEqual([
      { kind: 'api', name: '/orders', file: 'openapi.json' },
      { kind: 'api', name: 'listOrders', file: 'openapi.json' },
      { kind: 'api', name: 'createOrder', file: 'openapi.json' },
    ])
  })

  it('extracts rpc services and schema messages from proto', () => {
    const contracts = extractProvidedContracts('orders-proto', { 'orders.proto': protoFile })
    expect(contracts).toEqual([
      { kind: 'schema', name: 'OrderCancelled', file: 'orders.proto' },
      { kind: 'rpc', name: 'OrderService', file: 'orders.proto' },
    ])
  })

  it('extracts root operation fields and type names from GraphQL', () => {
    const contracts = extractProvidedContracts('orders-gql', { 'schema.graphql': graphqlFile })
    expect(contracts).toEqual([
      { kind: 'schema', name: 'Order', file: 'schema.graphql' },
      { kind: 'api', name: 'orders', file: 'schema.graphql' },
      { kind: 'api', name: 'order', file: 'schema.graphql' },
    ])
  })

  it('extracts event names from event registry files', () => {
    const contracts = extractProvidedContracts('events-repo', {
      'events/order-cancelled.json': JSON.stringify({ name: 'order.cancelled', version: 2 }),
      'events/order-created.yaml': 'name: order.created\nversion: 1\n',
    })
    expect(contracts).toEqual([
      { kind: 'event', name: 'order.cancelled', file: 'events/order-cancelled.json' },
      { kind: 'event', name: 'order.created', file: 'events/order-created.yaml' },
    ])
  })

  it('deduplicates identical kind+name declarations within one repo', () => {
    const contracts = extractProvidedContracts('dup', {
      'a.proto': protoFile,
      'b.proto': protoFile,
    })
    expect(contracts).toHaveLength(2)
  })
})

describe('resolveContractConsumers (consumer side)', () => {
  it('wires consumers to providers through referenced contract tokens', () => {
    const contracts = contractMap([
      ['orders-api', extractProvidedContracts('orders-api', { 'openapi.yaml': openapiYaml })],
      ['web', []],
    ])
    const files = {
      'orders-api': { 'openapi.yaml': openapiYaml, 'src/routes.ts': 'const r = route("/orders")' },
      web: { 'src/api.ts': "await client.get('/orders')" },
    }
    expect(resolveContractConsumers({ contracts, files })).toEqual([
      {
        from: 'web',
        to: 'orders-api',
        type: 'contract',
        contractRef: { kind: 'api', name: '/orders' },
        strength: 0.9,
      },
    ])
  })

  it('matches event tokens only at identifier boundaries', () => {
    const contracts = contractMap([
      ['events-repo', extractProvidedContracts('events-repo', {
        'events/order-cancelled.json': JSON.stringify({ name: 'order.cancelled' }),
      })],
      ['notify', []],
      ['legacy', []],
    ])
    const files = {
      'events-repo': { 'events/order-cancelled.json': '{"name":"order.cancelled"}' },
      notify: { 'src/handler.ts': "on('order.cancelled', handle)" },
      legacy: { 'src/old.ts': "on('order.cancelled.v2', handle)" },
    }
    expect(resolveContractConsumers({ contracts, files })).toEqual([
      {
        from: 'notify',
        to: 'events-repo',
        type: 'contract',
        contractRef: { kind: 'event', name: 'order.cancelled' },
        strength: 0.9,
      },
    ])
  })

  it('never creates self edges and never searches lock files', () => {
    const contracts = contractMap([
      ['orders-api', extractProvidedContracts('orders-api', { 'openapi.yaml': openapiYaml })],
      ['web', []],
    ])
    const files = {
      'orders-api': { 'openapi.yaml': openapiYaml },
      web: { 'pnpm-lock.yaml': 'registry/order.listOrders.tar.gz', 'src/api.ts': 'unrelated' },
    }
    expect(resolveContractConsumers({ contracts, files })).toEqual([])
  })

  it('duplicate providers of the same contract are skipped, not wired', () => {
    const contracts = contractMap([
      ['spec-a', [{ kind: 'api', name: '/orders', file: 'openapi.yaml' }]],
      ['spec-b', [{ kind: 'api', name: '/orders', file: 'openapi.yaml' }]],
    ])
    const files = {
      'spec-a': { 'openapi.yaml': 'paths:\n  /orders:\n    get: {}' },
      'spec-b': { 'openapi.yaml': 'paths:\n  /orders:\n    get: {}' },
    }
    expect(resolveContractConsumers({ contracts, files })).toEqual([])
  })

  it('produces one edge per contract token, sorted deterministically', () => {
    const contracts = contractMap([
      ['orders-proto', extractProvidedContracts('orders-proto', { 'orders.proto': protoFile })],
      ['notify', []],
    ])
    const files = {
      'orders-proto': { 'orders.proto': protoFile },
      notify: { 'src/client.ts': 'const client = new OrderService(transport); type X = OrderCancelled' },
    }
    const edges = resolveContractConsumers({ contracts, files })
    expect(edges.map(e => [e.from, e.to, e.contractRef?.name])).toEqual([
      ['notify', 'orders-proto', 'OrderCancelled'],
      ['notify', 'orders-proto', 'OrderService'],
    ])
  })
})
