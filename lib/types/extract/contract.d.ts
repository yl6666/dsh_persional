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
import type { AutoEdgeInput } from '../graph/store.ts';
import type { ContractKind } from '../graph/types.ts';
/** One contract a repo provides. */
export interface ContractDeclaration {
    readonly kind: ContractKind;
    readonly name: string;
    readonly file: string;
}
/** Does this path carry a contract declaration? */
export declare function isContractFile(path: string): boolean;
/**
 * Extract the contracts one repo PROVIDES from its files. Only files passing
 * {@link isContractFile} are consumed; within one repo a (kind, name) pair
 * deduplicates to its first declaration.
 */
export declare function extractProvidedContracts(repo: string, files: Readonly<Record<string, string>>): ContractDeclaration[];
export interface ContractResolutionInput {
    /** Provider repo -> contracts it provides. */
    readonly contracts: ReadonlyMap<string, readonly ContractDeclaration[]>;
    /** Every repo's searchable files (path -> content). */
    readonly files: Readonly<Record<string, Readonly<Record<string, string>>>>;
}
/**
 * Resolve contract consumers into contract edges (consumer -> provider).
 * A repo consumes a contract when a searchable file references the contract
 * token at identifier boundaries. Providers of the same (kind, name) are
 * treated as duplicate declarations, not consumers.
 */
export declare function resolveContractConsumers(input: ContractResolutionInput): AutoEdgeInput[];
