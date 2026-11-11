// The engine's public surface (branch engine-phase1). The engine records the facts of a business (parties, documents, money, allocations, corrections), derives what is true from them, and verifies them.
// It does not know what any business sells, and it does not know a single document KIND by name: what a kind means is a rule of the capability that issues it (and the business's configuration).
import * as money from "./money";
import * as facts from "./facts";
import * as ledger from "./ledger";

export { money, facts, ledger };
export { EngineError } from "./errors";
export type { EngineErrorCode } from "./errors";
export { FACT_TABLES, MUTABLE_TABLES } from "./tables";
export { verifyIntegrity, EVENT_MODEL } from "./integrity";
export type { IntegrityProblem, IntegrityWarning } from "./integrity";
export { readConfig } from "./config";
export type { EngineConfig } from "./config";
export type { Ctx } from "./facts";
import * as boundary from "./boundary";
import * as permissions from "./permissions";
import * as drafts from "./drafts";
import * as records from "./records";
import * as operations from "./operations";
import * as capabilities from "./capabilities";
import * as parties from "./parties";
import * as quotations from "./quotations";
import * as credits from "./credits";
import * as business from "./business";
import * as config from "./config";
import * as expenses from "./expenses";
import * as purchasing from "./purchasing";
export { boundary, permissions, drafts, records, operations, capabilities, parties, quotations, credits, business, config, expenses, purchasing };
