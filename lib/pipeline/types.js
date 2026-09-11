/**
 * Requirement pipeline artifacts - the handoff contracts between the eight
 * dispatch steps (docs/product-design.md 13.3, 5.2, 5.3).
 *
 * Every step of the one-dispatch pipeline consumes and produces only these
 * artifacts, so each step stays independently implementable, testable, and
 * replayable. Pure domain types: no LLM, fs, or host imports.
 * @module dsh-repo-board
 */
export {};
