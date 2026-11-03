// Semantic search: embeds queries and records with Workers AI (BGE
// embeddings) and retrieves nearest neighbours from the Vectorize index
// populated by /admin/embed-records. Every entry point returns empty on
// any failure, so callers degrade to keyword-only search.

export const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";
export const EMBED_DIMENSIONS = 768;

export interface SemanticEnv {
  AI: Ai;
  VECTORIZE: VectorizeIndex;
}

export interface SemanticHit {
  id: number;
  score: number;
}

/** Record text that gets embedded — identifier anchors exactness, the
 * abstract carries the meaning. */
export function recordText(docid: string | null, title: string | null, abstract: string | null): string {
  return [docid, title, abstract].filter(Boolean).join(". ");
}

export async function embedTexts(env: SemanticEnv, texts: string[]): Promise<number[][]> {
  // The generated AI types union every model's output; narrow to the
  // BGE output shape for the model constant above.
  const res = (await env.AI.run(EMBED_MODEL, { text: texts })) as Ai_Cf_Baai_Bge_Base_En_V1_5_Output;
  // The output unions the synchronous embeddings with an async-response
  // acknowledgement; only the former carries vectors.
  if (!("data" in res) || !res.data) return [];
  return res.data;
}

export async function semanticSearch(env: SemanticEnv, query: string, k: number): Promise<SemanticHit[]> {
  try {
    const vectors = await embedTexts(env, [query]);
    const vector = vectors[0];
    if (!vector) return [];
    const found = await env.VECTORIZE.query(vector, { topK: k, returnMetadata: "all" });
    return found.matches
      .map((m) => {
        const meta = m.metadata as { documentId?: number } | undefined;
        return { id: Number(meta?.documentId), score: m.score };
      })
      .filter((m) => Number.isFinite(m.id));
  } catch {
    return [];
  }
}

export interface SemanticHitV2 {
  key: string;
  flavor: string | null;
  score: number;
}

// Vectors written by /admin/embed-search carry { key, flavor } metadata —
// documents_search rows, no numeric id indirection.
export async function semanticSearchV2(env: SemanticEnv, query: string, k: number): Promise<SemanticHitV2[]> {
  try {
    const vectors = await embedTexts(env, [query]);
    const vector = vectors[0];
    if (!vector) return [];
    const found = await env.VECTORIZE.query(vector, { topK: k, returnMetadata: "all" });
    return found.matches.flatMap((m) => {
      const meta = m.metadata as { key?: string; flavor?: string } | undefined;
      return meta?.key ? [{ key: meta.key, flavor: meta.flavor ?? null, score: m.score }] : [];
    });
  } catch {
    return [];
  }
}

/** Reciprocal-rank fusion: blends two ranked lists without comparing
 * their raw scores (cosine and keyword relevance live on different
 * scales). k=60 is the standard damping constant. */
export function fuseRankings<T extends { id: number | string }>(primary: T[], secondary: T[], k = 60): T[] {
  const scores = new Map<number | string, number>();
  primary.forEach((item, i) => scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (k + i + 1)));
  const seen = new Set(primary.map((i) => i.id));
  const extra: T[] = [];
  secondary.forEach((item, i) => {
    scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (k + i + 1));
    if (!seen.has(item.id)) extra.push(item);
  });
  return [...primary, ...extra].sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0));
}
