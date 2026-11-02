// The engine's public surface (branch engine-phase1). The engine records the facts of a business (parties, documents, money, allocations, corrections), derives what is true from them, and verifies them.
// It does not know what any business sells, and it does not know a single document KIND by name: what a kind means is a rule of the capability that issues it (and the business's configuration).
import * as money from "./money";
import * as facts from "./facts";
import * as ledger from "./ledger";

export { money, facts, ledger };
export { EngineError } from "./errors";
export type { EngineErrorCode } from "./errors";
export { FACT_TABLES, MUTABLE_TABLES } from "./tables";
export { verifyIntegrity } from "./integrity";
export type { IntegrityProblem } from "./integrity";
export { readConfig } from "./config";
export type { EngineConfig } from "./config";
export type { Ctx } from "./facts";
