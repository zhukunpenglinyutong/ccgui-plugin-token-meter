/** 数字/时长格式化（UI 与测试共享）。 */

/** token 紧凑格式：999 → "999"；17200 → "17.2K"；1_500_000 → "1.5M"。 */
export function formatTokens(n: number): string {
  const v = Math.max(0, Math.round(n));
  if (v < 1000) return String(v);
  if (v < 1_000_000) {
    const k = v / 1000;
    return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}K`;
  }
  const m = v / 1_000_000;
  return `${m >= 100 ? Math.round(m) : Math.round(m * 10) / 10}M`;
}

/** 紧凑时长：45.2s 以内带一位小数，之上 2m42s（照 StatsPills 口径）。 */
export function formatDuration(ms: number, zh: boolean): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `${Math.round(s * 10) / 10}s`;
  const whole = Math.round(s);
  const m = Math.floor(whole / 60);
  const sec = whole % 60;
  return zh ? `${m}分${sec}秒` : `${m}m${sec}s`;
}

/**
 * 缓存命中百分比文本（照 StatsPills 的 formatCacheHitPercent 口径）：
 * 分母为 0 → null；全中 → "100"；否则取仍舍入 <100 的最小精度
 * （99.96% → "99.96"，99.4% → "99"）。
 */
export function formatCacheHitPercent(hit: number, denominator: number): string | null {
  if (denominator <= 0) return null;
  if (hit <= 0) return "0";
  if (hit >= denominator) return "100";
  const pct = (hit / denominator) * 100;
  for (let d = 0; d <= 4; d++) {
    const rounded = Number(pct.toFixed(d));
    if (rounded < 100) return pct.toFixed(d);
  }
  return "99.9999";
}
