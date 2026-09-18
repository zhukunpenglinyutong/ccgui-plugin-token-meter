/**
 * 归一化器（纯函数）：把各引擎原始 usage JSON 折成统一的不重叠四桶。
 *
 * 语义基线 = 宿主 desktop-cc-gui/src/features/chat/usage.ts 的 parseUsage
 * （逐条复制：codex last_token_usage 嵌套优先、cached_input_tokens 嵌在
 * input_tokens 内需折出 disjoint、三套 cache 命名），再扩超集：
 * DeepSeek 线协议、OpenAI 兼容拼写、Gemini 风格、opencode part.tokens。
 *
 * 宿主 parseUsage 的 contextWindow 与本插件无关，刻意不复制。
 */

export interface NormalizedUsage {
  /** 未缓存输入（新鲜 prompt token）。 */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function num(u: Record<string, unknown>, k: string): number {
  const v = u[k];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function firstNum(u: Record<string, unknown>, keys: string[]): number {
  for (const k of keys) {
    const v = num(u, k);
    if (v) return v;
  }
  return 0;
}

/**
 * 该报告的 cache 计数是否嵌在 input 内（宿主 usage.ts 的 cacheInsideInput
 * 推广）：codex（cached_input_tokens/cache_write_input_tokens）、DeepSeek
 * （prompt_cache_hit_tokens）、OpenAI 兼容（prompt_tokens_details.cached_tokens）、
 * Gemini（cachedContentTokenCount）四家的 prompt 总量都含命中部分，须减出；
 * claude（cache_read_input_tokens）、pi/omp（cacheRead）、opencode
 * （cache.{read,write}）的 cache 在 input 之外，不动 input。
 */
function cacheInsideInput(
  u: Record<string, unknown>,
  promptDetails: Record<string, unknown> | null,
): boolean {
  return (
    typeof u.cached_input_tokens === "number" ||
    typeof u.cache_write_input_tokens === "number" ||
    typeof u.prompt_cache_hit_tokens === "number" ||
    typeof u.cachedContentTokenCount === "number" ||
    (promptDetails !== null && typeof promptDetails.cached_tokens === "number")
  );
}

/** 归一化一条引擎原始 usage；无任何 token 时返回 null。 */
export function normalizeUsage(usage: unknown): NormalizedUsage | null {
  const raw = asRecord(usage);
  if (!raw) return null;
  // 宿主语义：codex token_count 形状的 last_token_usage 嵌套优先（占用
  // 快照；total_token_usage 是会话累计，计数模式在 engines.ts 判定）。
  const u = asRecord(raw.last_token_usage) ?? raw;
  const promptDetails = asRecord(u.prompt_tokens_details);
  const cacheObj = asRecord(u.cache);

  const reportedInput = firstNum(u, [
    "input_tokens", // claude / codex / agy
    "input", // pi / omp / opencode
    "prompt_tokens", // OpenAI 兼容（kimi / grok / dsh）
    "inputTokens", // ACP camelCase（qoder）
    "promptTokenCount", // Gemini 风格
  ]);
  const output = firstNum(u, [
    "output_tokens",
    "output",
    "completion_tokens",
    "outputTokens",
    "candidatesTokenCount",
  ]);
  const cacheRead =
    firstNum(u, ["cache_read_input_tokens", "cacheRead", "cached_input_tokens"]) ||
    num(u, "prompt_cache_hit_tokens") || // DeepSeek 线协议
    (promptDetails ? num(promptDetails, "cached_tokens") : 0) || // OpenAI 兼容拼写
    num(u, "cachedContentTokenCount") || // Gemini 风格
    (cacheObj ? num(cacheObj, "read") : 0); // opencode part.tokens
  const cacheWrite =
    firstNum(u, [
      "cache_creation_input_tokens",
      "cacheWrite",
      "cache_write_input_tokens",
    ]) || (cacheObj ? num(cacheObj, "write") : 0);
  // 宿主 disjoint 规则：cache 嵌在 input 里的家族须折出，否则 total 按
  // 整个 cache 体量虚增（cache 重的 codex 轮会数出 ~3 倍真实 prompt）。
  const input = cacheInsideInput(u, promptDetails)
    ? Math.max(0, reportedInput - cacheRead - cacheWrite)
    : reportedInput;
  const total =
    firstNum(u, ["total_tokens", "totalTokens", "totalTokenCount"]) ||
    input + output + cacheRead + cacheWrite;
  if (!total) return null;
  return { input, output, cacheRead, cacheWrite, total };
}
