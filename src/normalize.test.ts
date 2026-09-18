import { describe, expect, it } from "vitest";
import { normalizeUsage } from "./normalize";
import { countingMode } from "./engines";

import claude from "../fixtures/claude-usage.json";
import claudeCompact from "../fixtures/claude-compact-usage.json";
import codex from "../fixtures/codex-usage.json";
import codexTurnCompleted from "../fixtures/codex-turn-completed-usage.json";
import codexCumulative from "../fixtures/codex-cumulative.json";
import kimi from "../fixtures/kimi-usage.json";
import grok from "../fixtures/grok-usage.json";
import pi from "../fixtures/pi-usage.json";
import dsh from "../fixtures/dsh-usage.json";
import agy from "../fixtures/agy-usage.json";
import opencode from "../fixtures/opencode-usage.json";
import qoder from "../fixtures/qoder-usage.json";
import gemini from "../fixtures/gemini-usage.json";
import empty from "../fixtures/empty-usage.json";

describe("normalizeUsage：各引擎 fixture → disjoint 分桶", () => {
  it("claude：cache 在 input 之外，不动 input", () => {
    expect(normalizeUsage(claude)).toEqual({
      input: 400,
      output: 300,
      cacheRead: 6000,
      cacheWrite: 1500,
      total: 8200, // 无 total_tokens → 四桶之和
    });
  });

  it("claude compact 占用快照：只有 input/total", () => {
    expect(normalizeUsage(claudeCompact)).toEqual({
      input: 8038,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 8038,
    });
  });

  it("codex：cached_input_tokens/cache_write 从 input 折出（嵌套 disjoint）", () => {
    expect(normalizeUsage(codex)).toEqual({
      input: 500, // 8000 - 6000 - 1500
      output: 300,
      cacheRead: 6000,
      cacheWrite: 1500,
      total: 8300, // 采用报告值 total_tokens = input + output
    });
  });

  it("codex turn.completed 轮汇总同构折出", () => {
    expect(normalizeUsage(codexTurnCompleted)).toEqual({
      input: 2300, // 8300 - 6000
      output: 1200,
      cacheRead: 6000,
      cacheWrite: 0,
      total: 9500,
    });
  });

  it("codex token_count 形状：last_token_usage 嵌套优先", () => {
    expect(normalizeUsage(codexCumulative)).toEqual({
      input: 1000, // 4000 - 3000
      output: 200,
      cacheRead: 3000,
      cacheWrite: 0,
      total: 4200,
    });
    // 同 payload 的 total_token_usage 被识别为累计快照 → cumulative-replace。
    expect(countingMode("codex", codexCumulative)).toBe("cumulative-replace");
    expect(countingMode("codex", codex)).toBe("sum");
    expect(countingMode("pi", pi)).toBe("sum");
  });

  it("kimi：OpenAI 兼容，prompt_tokens_details.cached_tokens 从 prompt_tokens 折出", () => {
    expect(normalizeUsage(kimi)).toEqual({
      input: 1104, // 5200 - 4096
      output: 640,
      cacheRead: 4096,
      cacheWrite: 0,
      total: 5840,
    });
  });

  it("grok：OpenAI 兼容无缓存字段", () => {
    expect(normalizeUsage(grok)).toEqual({
      input: 2100,
      output: 350,
      cacheRead: 0,
      cacheWrite: 0,
      total: 2450,
    });
  });

  it("pi/omp：裸键命名，cache 在 input 之外", () => {
    expect(normalizeUsage(pi)).toEqual({
      input: 1200,
      output: 180,
      cacheRead: 5400,
      cacheWrite: 900,
      total: 7680,
    });
  });

  it("dsh：DeepSeek 线协议，prompt_tokens 含命中须减出（input = miss）", () => {
    expect(normalizeUsage(dsh)).toEqual({
      input: 908, // 9100 - 8192，恰等于 prompt_cache_miss_tokens
      output: 210,
      cacheRead: 8192,
      cacheWrite: 0,
      total: 9310,
    });
  });

  it("agy：最小形状", () => {
    expect(normalizeUsage(agy)).toEqual({
      input: 3,
      output: 4,
      cacheRead: 0,
      cacheWrite: 0,
      total: 7,
    });
  });

  it("opencode：part.tokens 的 cache.{read,write} 嵌套", () => {
    expect(normalizeUsage(opencode)).toEqual({
      input: 10,
      output: 4,
      cacheRead: 6400,
      cacheWrite: 512,
      total: 6926,
    });
  });

  it("qoder：ACP camelCase 命名", () => {
    expect(normalizeUsage(qoder)).toEqual({
      input: 4200,
      output: 260,
      cacheRead: 0,
      cacheWrite: 0,
      total: 4460,
    });
  });

  it("Gemini 风格超集：cachedContentTokenCount 从 promptTokenCount 折出", () => {
    expect(normalizeUsage(gemini)).toEqual({
      input: 3000, // 12000 - 9000
      output: 500,
      cacheRead: 9000,
      cacheWrite: 0,
      total: 12500,
    });
  });

  it("无任何 token → null；非对象 → null", () => {
    expect(normalizeUsage(empty)).toBeNull();
    expect(normalizeUsage(null)).toBeNull();
    expect(normalizeUsage("x")).toBeNull();
    expect(normalizeUsage({ input_tokens: 0, output_tokens: 0 })).toBeNull();
  });
});
