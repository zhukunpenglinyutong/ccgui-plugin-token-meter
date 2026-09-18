/**
 * 每引擎语义表：报告计数模式与 done-usage 策略。
 * 每条规则旁标注事实来源（宿主 desktop-cc-gui/src-tauri/src/engine/ 行号）。
 */

/** sum = 每条 usage 事件是一次模型响应的增量，累加；
 *  cumulative-replace = payload 携带会话累计快照，用快照替换而非累加。 */
export type CountingMode = "sum" | "cumulative-replace";

/** count = done 的 usage 无条件计入（该引擎的唯一用量来源）；
 *  fallback = 仅当该 runId 此前零 usage 报告时计入（兜底），否则只作轮结束信号。 */
export type DoneUsagePolicy = "count" | "fallback";

export interface EngineRule {
  counting: CountingMode;
  doneUsage: DoneUsagePolicy;
  /** 事实来源备注（源码文件:行号）。 */
  source: string;
}

const SUM_FALLBACK: Pick<EngineRule, "counting" | "doneUsage"> = {
  counting: "sum",
  doneUsage: "fallback",
};

/**
 * 引擎 id 全集：claude / codex / kimi / grok / pi / omp / dsh / agy /
 * opencode / qoder / qoder-cn。缺省规则 = sum + fallback，只覆盖 11 引擎
 * 里偏离缺省或有特殊发射时序的。
 */
export const ENGINE_RULES: Record<string, EngineRule> = {
  // usage://updated 只在 compact_boundary 发占用快照（claude.rs:157-167）；
  // 计费用量只在 result 行经 done 上报（claude.rs:269-292，轮汇总）。
  // fallback 正好覆盖：常规轮零 usage 报告 → done 计入。
  claude: {
    ...SUM_FALLBACK,
    source: "claude.rs:157-167,269-292（计费只经 done；compact 占用快照会抢先占位）",
  },
  // 每响应一条 token_usage_record（codex_usage.rs:86-89，逐响应增量 → sum），
  // turn.completed 的轮汇总再经 done 重报一次（codex.rs:142-150）——
  // fallback 跳过 done 用量，避免双计。若 payload 带 total_token_usage
  // （会话累计，codex_usage.rs:190-199 测试字面量形状）→ cumulative-replace。
  codex: {
    ...SUM_FALLBACK,
    source: "codex_usage.rs:86-89；codex.rs:142-150（done 重报轮汇总，fallback 去重）",
  },
  // 唯一用量来源是 end 事件的 usage（grok.rs:101-102），只经 usage://done
  // 到达 → doneUsage = count。
  grok: {
    counting: "sum",
    doneUsage: "count",
    source: "grok.rs:101-102（无独立 usage 事件，done 是唯一来源）",
  },
  // message_end 每响应一条（pi_family.rs:230-236）；done 不带 usage
  // （pi_family.rs:291 agent_end usage: None）→ fallback 天然空转。
  pi: { ...SUM_FALLBACK, source: "pi_family.rs:230-236,291" },
  omp: { ...SUM_FALLBACK, source: "pi_family.rs:230-236,291（omp 与 pi 同族解析器）" },
  // 每流式 chunk 一条 usage（dsh_session.rs:361-365，最高频）；done 回带
  // last_usage（dsh_session.rs:75-98）→ fallback 跳过避免双计。
  dsh: { ...SUM_FALLBACK, source: "dsh_session.rs:361-365,75-98（done 回带末条 usage）" },
  // result.usage 先作 Usage 事件（agy.rs:196-198）再随 Done 原样重报
  // （agy.rs:214-215）→ fallback 跳过 done，usage+done 不重复计数。
  agy: { ...SUM_FALLBACK, source: "agy.rs:196-198,214-215（usage 与 done 同一份，fallback 去重）" },
  // 每 step_finish 一条 part.tokens（opencode.rs:152-156）；done 不带
  // usage（opencode.rs:158-165）→ fallback 空转。
  opencode: { ...SUM_FALLBACK, source: "opencode.rs:152-156,158-165" },
  // session/prompt 结果 usage（qoder_session.rs:1016-1019）；done 回带
  // last_usage（qoder_session.rs:877-883）→ fallback 跳过避免双计。
  qoder: { ...SUM_FALLBACK, source: "qoder_session.rs:1016-1019,877-883" },
  "qoder-cn": { ...SUM_FALLBACK, source: "qoder_session.rs:1016-1019,877-883（qoder-cn 同解析器）" },
  // assistant 行 usage 透传（kimi.rs:86-88）；无 done 用量 → fallback 空转。
  kimi: { ...SUM_FALLBACK, source: "kimi.rs:86-88" },
};

const DEFAULT_RULE: EngineRule = {
  ...SUM_FALLBACK,
  source: "缺省（未列引擎按增量累加 + done 兜底）",
};

export function engineRule(engine: string): EngineRule {
  return ENGINE_RULES[engine] ?? DEFAULT_RULE;
}

/**
 * 计数模式判定：payload 驱动而非引擎驱动——凡是携带 total_token_usage
 * （会话累计字段，codex token_count 形状）的报告都用快照替换而非累加，
 * 避免「每响应一次 + 累计快照一次」的双报重复计数。
 */
export function countingMode(engine: string, rawData: unknown): CountingMode {
  if (
    rawData &&
    typeof rawData === "object" &&
    (rawData as Record<string, unknown>).total_token_usage &&
    typeof (rawData as Record<string, unknown>).total_token_usage === "object"
  ) {
    return "cumulative-replace";
  }
  return engineRule(engine).counting;
}

export function doneUsagePolicy(engine: string): DoneUsagePolicy {
  return engineRule(engine).doneUsage;
}
