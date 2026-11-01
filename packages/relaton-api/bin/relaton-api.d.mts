// Type surface of bin/relaton-api.mjs for the workerd-pool test suite; the
// CLI itself runs in Node.
export declare function buildWranglerConfig(
  config: unknown,
  opts?: { apiVersion?: string },
): Record<string, any>;

export declare function postChunks(
  flavor: string,
  files: { name: string; body: string }[],
  url: string,
  token: string,
  opts?: { attempts?: number },
): Promise<string>;

export declare function reconcile(
  flavor: string,
  base: string,
  v2: boolean,
  token: string,
  before: string,
): Promise<void>;

export declare const __cli: {
  apiBase(config: unknown, override?: string): string;
  adminToken(config: unknown, envOverride?: string): string;
  loadConfig(dir?: string): unknown;
  postJson(url: string, token: string, body: string, attempts?: number): Promise<unknown>;
  postChunks(
    flavor: string,
    files: { name: string; body: string }[],
    url: string,
    token: string,
    opts?: { attempts?: number },
  ): Promise<string>;
  reconcile(flavor: string, base: string, v2: boolean, token: string, before: string): Promise<void>;
  ingestMachineIndex(
    flavor: string,
    pagesBase: string | undefined,
    base: string,
    token: string,
  ): Promise<void>;
  ingestV2(
    flavor: string,
    values: Record<string, string | boolean | undefined>,
    base: string,
    token: string,
  ): Promise<void>;
  resolveEnvValue(value: unknown): unknown;
};
