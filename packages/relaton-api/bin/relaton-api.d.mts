// Type surface of bin/relaton-api.mjs for the workerd-pool test suite; the
// CLI itself runs in Node.
export declare function buildWranglerConfig(
  config: unknown,
  opts?: { apiVersion?: string },
): Record<string, any>;

export declare function ingestChunks(
  flavor: string,
  files: { name: string; body: string }[],
  base: string,
  token: string,
  opts?: { attempts?: number },
): Promise<void>;

export declare const __cli: {
  apiBase(config: unknown, override?: string): string;
  adminToken(config: unknown, envOverride?: string): string;
  loadConfig(dir?: string): unknown;
  postJson(url: string, token: string, body: string, attempts?: number): Promise<unknown>;
  ingestMachineIndex(
    flavor: string,
    pagesBase: string | undefined,
    base: string,
    token: string,
  ): Promise<void>;
  ingestChunks(
    flavor: string,
    files: { name: string; body: string }[],
    base: string,
    token: string,
    opts?: { attempts?: number },
  ): Promise<void>;
  resolveEnvValue(value: unknown): unknown;
};
