/**
 * @manebra/ontology — MNBR's shared concept layer: resolve messy user text to
 * canonical terms, then check answerability before an agent promises anything.
 * A thin layer over @manebra/shared and @manebra/compliance; it owns no
 * business logic and no I/O (non-pure checks come in as ports).
 */
export { resolveCategory, resolveMerchant, resolveCountry, resolveCorridor } from "./resolve";
export { coverage } from "./coverage";
export type {
  CoverageRequest,
  CoveragePorts,
  CoverageResult,
  CoverageGap,
  TraceStep,
} from "./coverage";
