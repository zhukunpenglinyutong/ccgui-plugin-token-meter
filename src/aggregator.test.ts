import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsageAggregator, type EngineEventPayloadLike } from "./aggregator";

import pi from "../fixtures/pi-usage.json";
import agy from "../fixtures/agy-usage.json";
import grok from "../fixtures/grok-usage.json";
import claude from "../fixtures/claude-usage.json";
import codexCumulative from "../fixtures/codex-cumulative.json";

let clock: number;

function makeAgg() {
  return new UsageAggregator({ now: () => clock, trailingMs: 250 });
}

function usage(
  runId: string,
  data: unknown,
  ts: number,
  engine = "pi",
  sessionId = "s1",
): EngineEventPayloadLike {
  return { runId, sessionId, engine, seq: 0, kind: "usage", data, ts } as EngineEventPayloadLike;
}

function done(
  runId: string,
  usageData: unknown,
  ts: number,
  engine = "pi",
  sessionId = "s1",
): EngineEventPayloadLike {
  return {
    runId,
    sessionId,
    engine,
    seq: 0,
    kind: "done",
    data: { usage: usageData },
    ts,
  } as EngineEventPayloadLike;
}

/** 推进 fake 定时器让 250ms 尾随节流的通知落地。 */
function flush() {
  vi.advanceTimersByTime(300);
}

beforeEach(() => {
  clock = 10_000;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("UsageAggregator", () => {
  it("turns 去重、steps 按报告计数、分桶求和", () => {
    const agg = makeAgg();
    agg.onUsageEvent(usage("r1", pi, 10_000));
    agg.onUsageEvent(usage("r1", pi, 11_000));
    agg.onUsageEvent(usage("r2", pi, 12_000));
    flush();
    const snap = agg.getSnapshot();
    expect(snap.turns).toBe(2);
    expect(snap.steps).toBe(3);
    expect(snap.input).toBe(1200 * 3);
    expect(snap.output).toBe(180 * 3);
    expect(snap.cacheRead).toBe(5400 * 3);
    expect(snap.cacheWrite).toBe(900 * 3);
    expect(snap.total).toBe(7680 * 3);
    expect(snap.cacheHitPct).toBe("72"); // 16200 / (3600+16200+2700) = 72%
    agg.dispose();
  });

  it("payload.ts 缺省时回退到达时间（注入时钟）", () => {
    const agg = makeAgg();
    const e = usage("r1", pi, 0);
    delete (e as { ts?: number }).ts;
    clock = 42_000;
    agg.onUsageEvent(e);
    clock = 43_000;
    const e2 = usage("r1", { input: 0, output: 50 }, 0);
    delete (e2 as { ts?: number }).ts;
    agg.onUsageEvent(e2);
    flush();
    expect(agg.getSnapshot().ewmaTps).toBeCloseTo(50, 5); // 50 tok / 1s
    agg.dispose();
  });

  it("done 冻结：running 转 false、EWMA 保持、tick 停止", () => {
    const agg = makeAgg();
    agg.onUsageEvent(usage("r1", { input: 0, output: 100 }, 10_000));
    agg.onUsageEvent(usage("r1", { input: 0, output: 100 }, 11_000));
    flush();
    expect(agg.ticking).toBe(true);
    const before = agg.getSnapshot();
    expect(before.running).toBe(true);
    expect(before.ewmaTps).toBeCloseTo(100, 5);
    agg.onDoneEvent(done("r1", null, 12_000));
    flush();
    const after = agg.getSnapshot();
    expect(after.running).toBe(false);
    expect(after.tps).toBeCloseTo(100, 5); // 冻结不衰减
    expect(agg.ticking).toBe(false); // 转闲即停
    agg.dispose();
  });

  it("running 会话速率随空闲线性衰减（1s tick 驱动）", () => {
    const agg = makeAgg();
    agg.onUsageEvent(usage("r1", { input: 0, output: 100 }, 10_000));
    agg.onUsageEvent(usage("r1", { input: 0, output: 100 }, 11_000));
    clock = 11_000;
    flush();
    expect(agg.getSnapshot().tps).toBeCloseTo(100, 5);
    // 5s 无新报告：衰减到一半。
    clock = 16_000;
    vi.advanceTimersByTime(1000); // 触发 tick → 新版本快照
    expect(agg.getSnapshot().tps).toBeCloseTo(50, 5);
    // 超过 10s 衰减窗口：归零。
    clock = 22_000;
    vi.advanceTimersByTime(1000);
    expect(agg.getSnapshot().tps).toBe(0);
    agg.dispose();
  });

  it("EWMA α=0.3 平滑方向：向新样本移动但滞后", () => {
    const agg = makeAgg();
    agg.onUsageEvent(usage("r1", { input: 0, output: 100 }, 10_000));
    agg.onUsageEvent(usage("r1", { input: 0, output: 100 }, 11_000)); // inst 100 → ewma 100
    agg.onUsageEvent(usage("r1", { input: 0, output: 10 }, 12_000)); // inst 10
    flush();
    const ewma = agg.getSnapshot().ewmaTps!;
    expect(ewma).toBeCloseTo(0.3 * 10 + 0.7 * 100, 5);
    expect(ewma).toBeLessThan(100);
    expect(ewma).toBeGreaterThan(10);
    agg.dispose();
  });

  it("单报告轮无 EWMA 样本：回退会话均速或 —", () => {
    const agg = makeAgg();
    agg.onUsageEvent(usage("r1", { input: 0, output: 100 }, 10_000));
    flush();
    // 只有一个 ts 点：无均速（lastTs == firstTs）→ null。
    expect(agg.getSnapshot().tps).toBeNull();
    agg.dispose();
  });

  it("grok done-only：done 的 usage 无条件计入", () => {
    const agg = makeAgg();
    agg.onDoneEvent(done("r1", grok, 10_000, "grok"));
    flush();
    const snap = agg.getSnapshot();
    expect(snap.steps).toBe(1);
    expect(snap.turns).toBe(1);
    expect(snap.total).toBe(2450);
    expect(snap.running).toBe(false); // done 即冻结
    agg.dispose();
  });

  it("agy usage+done 不重复计数（fallback 跳过 done 重报）", () => {
    const agg = makeAgg();
    agg.onUsageEvent(usage("r1", agy, 10_000, "agy"));
    agg.onDoneEvent(done("r1", agy, 10_500, "agy"));
    flush();
    const snap = agg.getSnapshot();
    expect(snap.steps).toBe(1); // 同一 usage 只计一次
    expect(snap.total).toBe(7);
    agg.dispose();
  });

  it("claude 常规轮：零 usage 报告，done 兜底计入", () => {
    const agg = makeAgg();
    agg.onDoneEvent(done("r1", claude, 10_000, "claude"));
    flush();
    const snap = agg.getSnapshot();
    expect(snap.steps).toBe(1);
    expect(snap.input).toBe(400);
    expect(snap.cacheRead).toBe(6000);
    agg.dispose();
  });

  it("cumulative-replace：total_token_usage 快照替换而非累加", () => {
    const agg = makeAgg();
    agg.onUsageEvent(usage("r1", codexCumulative, 10_000, "codex"));
    flush();
    // input 10000 + cacheRead 40000 + output 3000（替换后口径）。
    expect(agg.getSnapshot().total).toBe(53_000);
    const bigger = {
      total_token_usage: {
        input_tokens: 60_000,
        cached_input_tokens: 45_000,
        output_tokens: 5_000,
        total_tokens: 65_000,
      },
      last_token_usage: { input_tokens: 10_000, output_tokens: 2_000 },
    };
    agg.onUsageEvent(usage("r1", bigger, 20_000, "codex"));
    flush();
    const snap = agg.getSnapshot();
    expect(snap.input).toBe(15_000); // 60000-45000，替换而非 10000+15000
    expect(snap.output).toBe(5_000);
    expect(snap.cacheRead).toBe(45_000);
    // Δoutput 2000 / 10s → inst 200，EWMA 首样本即 200。
    expect(snap.ewmaTps).toBeCloseTo(200, 5);
    agg.dispose();
  });

  it("LRU：超过 100 会话逐出最旧不活跃条目，running 会话豁免", () => {
    const agg = makeAgg();
    // s0 保持 running；其余 100 个会话各自 done 转闲。
    agg.onUsageEvent(usage("r-hot", { input: 1, output: 1 }, 10_000, "pi", "s0"));
    for (let i = 1; i <= 100; i++) {
      agg.onUsageEvent(usage(`r${i}`, { input: 1, output: 1 }, 10_000 + i, "pi", `s${i}`));
      agg.onDoneEvent(done(`r${i}`, null, 10_000 + i, "pi", `s${i}`));
    }
    flush();
    expect(agg.sessionCount).toBe(100);
    // running 的 s0 必须存活；最旧的不活跃 s1 被逐出。
    const keys = [...(agg as never as { sessions: Map<string, unknown> }).sessions.keys()];
    expect(keys).toContain("pi/s0");
    expect(keys).not.toContain("pi/s1");
    expect(keys).toContain("pi/s100");
    agg.dispose();
  });

  it("scope=active 经 session://activated 跟踪；未激活时回退最近流量会话", () => {
    const agg = makeAgg();
    agg.onUsageEvent(usage("r1", { input: 10, output: 1 }, 10_000, "pi", "sA"));
    agg.onUsageEvent(usage("r2", { input: 20, output: 2 }, 11_000, "codex", "sB"));
    flush();
    // 未收到过激活事件 → 最近有流量的 sB。
    expect(agg.getSnapshot().input).toBe(20);
    agg.onSessionActivated({ engine: "pi", sessionId: "sA" });
    flush();
    expect(agg.getSnapshot().input).toBe(10);
    // 激活了无数据的会话 → 回退最近流量。
    agg.onSessionActivated({ engine: "kimi", sessionId: "sZ" });
    flush();
    expect(agg.getSnapshot().input).toBe(20);
    agg.dispose();
  });

  it("scope=all：全部会话合计", () => {
    const agg = makeAgg();
    agg.setConfig({ scope: "all" });
    agg.onUsageEvent(usage("r1", { input: 10, output: 1 }, 10_000, "pi", "sA"));
    agg.onUsageEvent(usage("r2", { input: 20, output: 2 }, 11_000, "codex", "sB"));
    flush();
    const snap = agg.getSnapshot();
    expect(snap.scope).toBe("all");
    expect(snap.input).toBe(30);
    expect(snap.turns).toBe(2);
    agg.dispose();
  });

  it("无缓存字段引擎：hasCache=false → UI 省略缓存段", () => {
    const agg = makeAgg();
    agg.onDoneEvent(done("r1", grok, 10_000, "grok"));
    flush();
    const snap = agg.getSnapshot();
    expect(snap.hasCache).toBe(false);
    expect(snap.cacheHitPct).toBe("0"); // 分母 = input = 2100，hit 0 → "0"
    agg.dispose();
  });

  it("空数据快照 empty=true；空闲时无任何定时器", () => {
    const agg = makeAgg();
    expect(agg.getSnapshot().empty).toBe(true);
    expect(agg.ticking).toBe(false);
    agg.dispose();
  });
});
