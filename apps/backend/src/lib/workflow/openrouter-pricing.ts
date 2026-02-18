/**
 * OpenRouter model pricing for cost calculation.
 * Fetches from OpenRouter API and caches. Uses fallback for unknown models.
 */

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

let cache: { map: Map<string, { prompt: number; completion: number }>; fetchedAt: number } | null = null;

/** Default per-token prices when model not found (~$1/1M prompt, $3/1M completion) */
const DEFAULT_PROMPT_PER_TOKEN = 0.000001;
const DEFAULT_COMPLETION_PER_TOKEN = 0.000003;

export interface ModelPricing {
  prompt: number;   // $ per token
  completion: number; // $ per token
}

export function getPricingForModel(modelId: string): ModelPricing {
  const map = cache?.map ?? new Map();
  const p = map.get(modelId);
  if (p) return p;
  const baseId = modelId.replace(/-\d+$/, '');
  const p2 = map.get(baseId);
  if (p2) return p2;
  return { prompt: DEFAULT_PROMPT_PER_TOKEN, completion: DEFAULT_COMPLETION_PER_TOKEN };
}

export function calculateCost(
  modelId: string,
  promptTokens: number,
  completionTokens: number
): number {
  const p = getPricingForModel(modelId);
  return promptTokens * p.prompt + completionTokens * p.completion;
}

export async function ensurePricingLoaded(): Promise<void> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) return;
  cache = { map: new Map(), fetchedAt: now };
  try {
    const res = await fetch(OPENROUTER_MODELS_URL);
    if (!res.ok) return;
    const data = (await res.json()) as { data?: Array<{ id: string; pricing?: { prompt?: string; completion?: string } }> };
    const models = data?.data ?? [];
    for (const m of models) {
      const prompt = parseFloat(m.pricing?.prompt ?? '0');
      const completion = parseFloat(m.pricing?.completion ?? '0');
      if (m.id) {
        cache.map.set(m.id, { prompt, completion });
      }
    }
  } catch {
    /* ignore fetch errors, use empty map -> fallback pricing */
  }
}
