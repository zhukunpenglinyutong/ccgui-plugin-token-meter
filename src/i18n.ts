/** 文案插件自带（不进宿主 i18n），按 ctx.host.locale 切换 zh/en。 */

export interface Copy {
  speedAria: (turns: number, steps: number, tps: string) => string;
  usageAria: (total: string, cacheHit: string | null) => string;
  tokPerSec: string;
  turnsUnit: string;
  stepsUnit: string;
  cacheHit: string;
  // 速度面板
  speedTitle: string;
  rowTurns: string;
  rowSteps: string;
  rowModelTime: string;
  rowEwma: string;
  rowAvg: string;
  // 用量面板
  usageTitle: string;
  rowInput: string;
  rowCacheRead: string;
  rowCacheWrite: string;
  rowOutput: string;
  rowTotal: string;
}

const ZH: Copy = {
  speedAria: (turns, steps, tps) => `${turns} 轮 ${steps} 步，速度 ${tps}`,
  usageAria: (total, cacheHit) =>
    cacheHit === null ? `共 ${total} token` : `共 ${total} token，缓存命中 ${cacheHit}%`,
  tokPerSec: "tok/s",
  turnsUnit: "轮",
  stepsUnit: "步",
  cacheHit: "缓存命中",
  speedTitle: "速度与节奏",
  rowTurns: "轮",
  rowSteps: "步",
  rowModelTime: "生成耗时",
  rowEwma: "瞬时速度（EWMA）",
  rowAvg: "会话均速",
  usageTitle: "Token 用量",
  rowInput: "未缓存输入",
  rowCacheRead: "缓存读取",
  rowCacheWrite: "缓存写入",
  rowOutput: "输出",
  rowTotal: "总计",
};

const EN: Copy = {
  speedAria: (turns, steps, tps) => `${turns} turns, ${steps} steps, ${tps}`,
  usageAria: (total, cacheHit) =>
    cacheHit === null ? `${total} tokens` : `${total} tokens, cache hit ${cacheHit}%`,
  tokPerSec: "tok/s",
  turnsUnit: "turns",
  stepsUnit: "steps",
  cacheHit: "cache hit",
  speedTitle: "Speed & pacing",
  rowTurns: "Turns",
  rowSteps: "Steps",
  rowModelTime: "Generation time",
  rowEwma: "Instant speed (EWMA)",
  rowAvg: "Session average",
  usageTitle: "Token usage",
  rowInput: "Uncached input",
  rowCacheRead: "Cache read",
  rowCacheWrite: "Cache write",
  rowOutput: "Output",
  rowTotal: "Total",
};

export function copy(locale: string): Copy {
  return locale.startsWith("zh") ? ZH : EN;
}
