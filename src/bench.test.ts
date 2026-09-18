/**
 * 微基准（作回归测试跑）：10 万条合成事件处理 < 200ms。
 * 混合形状（dsh 高频流式 / codex 嵌套 / pi 裸键）+ 每 20 条一个 done，
 * 覆盖 normalize + 聚合 + LRU + EWMA 全热路径。
 */
import { describe, expect, it } from "vitest";
import { UsageAggregator, type EngineEventPayloadLike } from "./aggregator";
import { performance } from "node:perf_hooks";

import dsh from "../fixtures/dsh-usage.json";
import codex from "../fixtures/codex-usage.json";
import pi from "../fixtures/pi-usage.json";

const EVENTS = 100_000;
const BUDGET_MS = 200;

describe("微基准：100k 事件", () => {
  it(`处理耗时 < ${BUDGET_MS}ms`, () => {
    const agg = new UsageAggregator({ trailingMs: 60_000 }); // 通知合并掉，只测热路径
    const shapes = [dsh, codex, pi];
    const engines = ["dsh", "codex", "pi"];
    const start = performance.now();
    let ts = 1_000_000;
    for (let i = 0; i < EVENTS; i++) {
      ts += 50;
      const session = `s${i % 20}`; // × 3 引擎 = 60 会话，低于 LRU 上限
      const runId = `r${Math.floor(i / 20)}`;
      const kind = i % 3;
      agg.onUsageEvent({
        runId,
        sessionId: session,
        engine: engines[kind],
        seq: i,
        kind: "usage",
        data: shapes[kind],
        ts,
      } as EngineEventPayloadLike);
      if (i % 20 === 19) {
        agg.onDoneEvent({
          runId,
          sessionId: session,
          engine: engines[kind],
          seq: i,
          kind: "done",
          data: { usage: null },
          ts,
        } as EngineEventPayloadLike);
      }
    }
    const elapsed = performance.now() - start;
    agg.dispose();
    // 防优化断言 + 结果合理性。
    expect(agg.sessionCount).toBe(60); // 20 会话 × 3 引擎
    expect(agg.getSnapshot().steps).toBeGreaterThan(0);
    console.log(`[bench] ${EVENTS} 事件耗时 ${elapsed.toFixed(1)}ms（预算 ${BUDGET_MS}ms）`);
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });
});
