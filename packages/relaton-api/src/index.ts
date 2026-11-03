import { createApp } from "./app";
import { parseConfig, type RelatonApiConfig } from "./config";

export { createApp } from "./app";
export { parseConfig, RelatonApiConfigSchema } from "./config";
export type { RelatonApiConfig } from "./config";
export type { AppEnv, Env } from "./env";
export { runIngestion } from "./ingest/sync";
// The pubid key derivation ships with the API: consumers deriving lookup
// keys (cloud store clients, the corpus harness) use the same semantics
// the worker does, corpus-pinned against pubid ruby.
export {
  applyUpdateCodes,
  canonicalize,
  detectFlavor,
  parse,
  yearOf,
} from "./pubid/index.ts";
export {
  allPartsKey,
  deriveKeys,
  lastPublisherKey,
  normKey,
  normalizeCode,
  undatedKey,
} from "./pubid/keys.ts";
export type { Identifier, Supplement } from "./pubid/types.ts";

export interface RelatonApi {
  app: ReturnType<typeof createApp>;
  config: RelatonApiConfig;
}

export function createRelatonApi(configInput: unknown = {}): RelatonApi {
  const config = parseConfig(configInput);
  return { app: createApp(config), config };
}
