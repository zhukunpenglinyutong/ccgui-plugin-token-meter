/**
 * 聚合器（性能关键，O(1)/事件）：把 usage://updated / usage://done 事件流
 * 折成每会话的定长扁平记录，再按 scope 投影成状态栏快照。
 *
 * - 定时器纪律：空闲（无 running 会话）时零定时器；有 running 会话时单条
 *   1s interval 驱动速率衰减显示，转闲即停。通知统一走 250ms 尾随节流。
 * - LRU：上限 MAX_SESSIONS 条，超出逐出最旧的不活跃条目。
 */

import { normalizeUsage, type NormalizedUsage } from "./normalize";
import { countingMode, doneUsagePolicy } from "./engines";
import { formatCacheHitPercent } from "./format";

export interface EngineEventPayloadLike {
  runId: string;
  sessionId: string | null;
  engine: string;
  kind: string;
  data: unknown;
  ts?: number;
  /** 宿主实测生成窗口（毫秒，SDK 0.3.15 起）：该报告对应的模型真实生成
   *  时间，工具执行与等待不计入。缺失时回退相邻报告 ts 间隔。 */
  genMs?: number;
}

export interface MeterConfig {
  scope: "active" | "all";
  showSpeed: boolean;
  showCacheHit: boolean;
}

export const DEFAULT_CONFIG: MeterConfig = {
  scope: "active",
  showSpeed: true,
  showCacheHit: true,
};

/** 速率 EWMA 平滑系数。 */
const EWMA_ALPHA = 0.3;
/** LRU 上限。 */
const MAX_SESSIONS = 100;
/** running 状态下无新报告时速度线性衰减到 0 的窗口。 */
const DECAY_WINDOW_MS = 10_000;

/** 定长扁平的每会话聚合记录（热路径上不新建对象）。 */
interface SessionAgg {
  key: string;
  engine: string;
  sessionId: string | null;
  /** 去重的轮（runId 集合）。 */
  turns: Set<string>;
  /** 步 = 计入的用量报告数（一报告 ≈ 一次模型响应）。 */
  steps: number;
  /** 该 runId 已有 usage 报告 → done 的 usage 跳过（fallback 去重）。 */
  runsWithUsage: Set<string>;
  sumInput: number;
  sumOutput: number;
  sumCacheRead: number;
  sumCacheWrite: number;
  /** 带宿主实测窗口的报告累计输出（生成口径均速的分子）。 */
  genOutput: number;
  /** 生成窗口合计（毫秒）；> 0 时模型用时与均速都走实测口径。 */
  genMs: number;
  /** 会话级均速口径（无实测窗口时的回退）：Σoutput / (lastTs - firstTs)。 */
  firstTs: number | null;
  lastTs: number | null;
  /** 当前活跃 run 的 EWMA 基线：上次报告时刻与该 run 已累计的输出。 */
  activeRunId: string | null;
  runLastTs: number | null;
  runOutput: number;
  ewmaTps: number | null;
  running: boolean;
  /** cumulative-replace 模式的上一帧快照（总量与时刻）。 */
  lastSnapshot: NormalizedUsage | null;
  lastSnapshotTs: number | null;
  /** LRU 触碰戳（事件序号，不用墙钟）。 */
  touched: number;
}

export interface MeterSnapshot {
  /** 尚无任何用量数据。 */
  empty: boolean;
  scope: "active" | "all";
  showSpeed: boolean;
  showCacheHit: boolean;
  running: boolean;
  turns: number;
  steps: number;
  /** 展示速度（tok/s，已含衰减/冻结）；null → "—"。 */
  tps: number | null;
  /** 冻结前的 EWMA 与均速，面板用。 */
  ewmaTps: number | null;
  avgTps: number | null;
  /** 模型用时（毫秒）：Σ宿主实测生成窗口；无实测时回退首末报告跨度。 */
  modelMs: number | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  /** 有任一 cache 计数（无缓存字段的引擎自动省略缓存段）。 */
  hasCache: boolean;
  /** 缓存命中百分比文本；分母为 0 → null。 */
  cacheHitPct: string | null;
  /** scope=active 时当前跟踪的会话引擎名（诊断/aria 用）。 */
  engine: string | null;
}

const EMPTY_SNAPSHOT: MeterSnapshot = {
  empty: true,
  scope: "active",
  showSpeed: true,
  showCacheHit: true,
  running: false,
  turns: 0,
  steps: 0,
  tps: null,
  ewmaTps: null,
  avgTps: null,
  modelMs: null,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  hasCache: false,
  cacheHitPct: null,
  engine: null,
};

export interface AggregatorOptions {
  /** 测试注入的时钟；缺省 Date.now。 */
  now?: () => number;
  /** 通知尾随节流窗口（测试可设小）；缺省 250ms。 */
  trailingMs?: number;
}
/** 定时器句柄：webview 环境为 number、node 测试环境为 Timeout 对象；
 *  模块内集中命名，仅经 clearTimeout/clearInterval 回收。 */
type TimerHandle = ReturnType<typeof setTimeout>;

export class UsageAggregator {
  private sessions = new Map<string, SessionAgg>();
  private listeners = new Set<() => void>();
  private version = 0;
  private cachedVersion = -1;
  private cachedSnapshot: MeterSnapshot = EMPTY_SNAPSHOT;
  private config: MeterConfig = { ...DEFAULT_CONFIG };
  /** 最近激活会话；undefined = 尚未收到过激活事件（回退最近流量会话）。 */
  private activated: { engine: string | null; sessionId: string | null } | undefined;
  private touchSeq = 0;
  private notifyTimer: TimerHandle | null = null;
  private tickTimer: TimerHandle | null = null;
  private readonly now: () => number;
  private readonly trailingMs: number;

  constructor(opts: AggregatorOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.trailingMs = opts.trailingMs ?? 250;
  }

  // ---------- 事件入口 ----------

  onUsageEvent(event: EngineEventPayloadLike): void {
    const agg = this.aggFor(event);
    const ts = typeof event.ts === "number" ? event.ts : this.now();
    const mode = countingMode(event.engine, event.data);
    // 宿主实测生成窗口：工具执行、用户等待与轮间隔都已排除。缺失时
    // 回退相邻报告 ts 间隔（旧宿主 / 未计时的报告）。
    const genMs =
      typeof event.genMs === "number" && Number.isFinite(event.genMs) && event.genMs > 0
        ? event.genMs
        : null;

    if (mode === "cumulative-replace") {
      const snapRaw = (event.data as Record<string, unknown>).total_token_usage;
      const snap = normalizeUsage(snapRaw);
      if (snap) {
        // 快照替换：会话累计口径下 Δoutput 驱动 EWMA，总量直接替换。
        // 首帧无法得出 Δ（快照是会话累计值），不产生样本。
        const prev = agg.lastSnapshot;
        if (prev) {
          const dOut = snap.output - prev.output;
          if (dOut > 0) {
            if (genMs !== null) {
              this.applyEwma(agg, dOut, genMs);
              agg.genMs += genMs;
              agg.genOutput += dOut;
            } else if (agg.lastSnapshotTs !== null && ts > agg.lastSnapshotTs) {
              this.applyEwma(agg, dOut, ts - agg.lastSnapshotTs);
            }
          }
        }
        agg.sumInput = snap.input;
        agg.sumOutput = snap.output;
        agg.sumCacheRead = snap.cacheRead;
        agg.sumCacheWrite = snap.cacheWrite;
        agg.lastSnapshot = snap;
        agg.lastSnapshotTs = ts;
        agg.steps += 1;
        agg.turns.add(event.runId);
        agg.runsWithUsage.add(event.runId);
        this.markRunning(agg, event.runId, ts);
      }
    } else {
      const parsed = normalizeUsage(event.data);
      if (parsed) {
        if (agg.activeRunId !== event.runId) {
          // 新 run：重置 EWMA 基线（无实测窗口时首报告无 Δ，不产生样本）。
          agg.activeRunId = event.runId;
          agg.runOutput = 0;
          agg.runLastTs = null;
        }
        agg.sumInput += parsed.input;
        agg.sumOutput += parsed.output;
        agg.sumCacheRead += parsed.cacheRead;
        agg.sumCacheWrite += parsed.cacheWrite;
        agg.runOutput += parsed.output;
        if (genMs !== null && parsed.output > 0) {
          // 实测窗口存在：无需等第二条报告，单报告轮（claude 一轮一条）
          // 也直接出样本，且分母不含工具时间。
          agg.genMs += genMs;
          agg.genOutput += parsed.output;
          this.applyEwma(agg, parsed.output, genMs);
        } else if (agg.runLastTs !== null && ts > agg.runLastTs) {
          // 基线差 = 上次报告至今的 Δoutput（本次报告量）。
          this.applyEwma(agg, parsed.output, ts - agg.runLastTs);
        }
        agg.runLastTs = ts;
        agg.steps += 1;
        agg.turns.add(event.runId);
        agg.runsWithUsage.add(event.runId);
        this.markRunning(agg, event.runId, ts);
      }
    }
    agg.touched = ++this.touchSeq;
    this.scheduleNotify();
  }

  onDoneEvent(event: EngineEventPayloadLike): void {
    const data = (event.data ?? {}) as { usage?: unknown };
    const hasUsage = data.usage != null;
    // 纯结束信号且会话未知：不建条目。
    const key = this.keyOf(event);
    let agg = this.sessions.get(key);
    const policy = doneUsagePolicy(event.engine);
    const shouldCount =
      hasUsage &&
      (policy === "count" || !(agg && agg.runsWithUsage.has(event.runId)));
    if (shouldCount) {
      // 复用 usage 路径：done 携带的用量按同一条增量规则计入。
      this.onUsageEvent({ ...event, data: data.usage });
      agg = this.sessions.get(key);
    }
    if (!agg) {
      if (hasUsage) this.scheduleNotify();
      return;
    }
    agg.turns.add(event.runId);
    agg.running = false;
    if (agg.activeRunId === event.runId) agg.activeRunId = null;
    agg.touched = ++this.touchSeq;
    if (!this.anyRunning()) this.stopTick();
    this.scheduleNotify();
  }

  onSessionActivated(payload: { engine: string | null; sessionId: string | null }): void {
    this.activated = payload;
    this.scheduleNotify();
  }

  setConfig(patch: Partial<MeterConfig>): void {
    this.config = { ...this.config, ...patch };
    this.cachedVersion = -1;
    this.scheduleNotify();
  }

  // ---------- 订阅 ----------

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  getSnapshot = (): MeterSnapshot => {
    if (this.cachedVersion === this.version) return this.cachedSnapshot;
    const snap = this.computeSnapshot();
    this.cachedVersion = this.version;
    this.cachedSnapshot = snap;
    return snap;
  };

  /** 测试/卸载用：停全部定时器。 */
  dispose(): void {
    if (this.notifyTimer !== null) clearTimeout(this.notifyTimer);
    if (this.tickTimer !== null) clearInterval(this.tickTimer);
    this.notifyTimer = null;
    this.tickTimer = null;
    this.listeners.clear();
  }

  /** 测试观测口：当前会话条数与是否在 ticking。 */
  get sessionCount(): number {
    return this.sessions.size;
  }
  get ticking(): boolean {
    return this.tickTimer !== null;
  }

  // ---------- 内部 ----------

  private keyOf(event: { engine: string; sessionId: string | null; runId: string }): string {
    // pending 标签 sessionId 为 null：退化为 runId 键，拿到真 sessionId 的
    // 后续事件会另开条目——pending 阶段用量很少，合并价值低于键漂移成本。
    return `${event.engine}/${event.sessionId ?? `run:${event.runId}`}`;
  }

  private aggFor(event: EngineEventPayloadLike): SessionAgg {
    const key = this.keyOf(event);
    let agg = this.sessions.get(key);
    if (agg) return agg;
    agg = {
      key,
      engine: event.engine,
      sessionId: event.sessionId,
      turns: new Set(),
      steps: 0,
      runsWithUsage: new Set(),
      sumInput: 0,
      sumOutput: 0,
      sumCacheRead: 0,
      sumCacheWrite: 0,
      genOutput: 0,
      genMs: 0,
      firstTs: null,
      lastTs: null,
      activeRunId: null,
      runLastTs: null,
      runOutput: 0,
      ewmaTps: null,
      running: false,
      lastSnapshot: null,
      lastSnapshotTs: null,
      touched: ++this.touchSeq,
    };
    this.sessions.set(key, agg);
    this.evictIfNeeded();
    return agg;
  }

  /** LRU：超出上限时逐出最旧的不活跃条目（running 会话永不逐出）。 */
  private evictIfNeeded(): void {
    if (this.sessions.size <= MAX_SESSIONS) return;
    let oldestKey: string | null = null;
    let oldestTouch = Infinity;
    for (const [key, agg] of this.sessions) {
      if (agg.running) continue;
      if (agg.touched < oldestTouch) {
        oldestTouch = agg.touched;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) this.sessions.delete(oldestKey);
  }

  private applyEwma(agg: SessionAgg, dOut: number, dtMs: number): void {
    if (dOut <= 0 || dtMs <= 0) return;
    const inst = dOut / (dtMs / 1000);
    agg.ewmaTps = agg.ewmaTps === null ? inst : EWMA_ALPHA * inst + (1 - EWMA_ALPHA) * agg.ewmaTps;
  }

  private markRunning(agg: SessionAgg, runId: string, ts: number): void {
    if (agg.firstTs === null) agg.firstTs = ts;
    agg.lastTs = ts;
    if (!agg.running) {
      agg.running = true;
      this.ensureTick();
    }
    if (agg.activeRunId === null) agg.activeRunId = runId;
  }

  private anyRunning(): boolean {
    for (const agg of this.sessions.values()) if (agg.running) return true;
    return false;
  }

  // ---------- 定时器纪律 ----------

  private ensureTick(): void {
    if (this.tickTimer !== null) return;
    this.tickTimer = setInterval(() => {
      if (!this.anyRunning()) {
        this.stopTick();
        return;
      }
      // 1s 速率衰减显示：直接推一版快照（绕过 250ms 节流，节奏即 1s）。
      this.version++;
      this.flush();
    }, 1000);
  }

  private stopTick(): void {
    if (this.tickTimer !== null) clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  /** 250ms 尾随节流：事件洪峰（dsh 每 chunk 一条）合并为一次通知。 */
  private scheduleNotify(): void {
    if (this.notifyTimer !== null) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      this.version++;
      this.flush();
    }, this.trailingMs);
  }

  private flush(): void {
    for (const cb of [...this.listeners]) {
      try {
        cb();
      } catch {
        // 监听器错误不扩散（与宿主事件总线同策略）。
      }
    }
  }

  // ---------- 快照投影 ----------

  /** 展示速度：冻结轮取 EWMA 原值；running 轮按空闲时长线性衰减。 */
  private displayTps(agg: SessionAgg, nowMs: number): number | null {
    if (agg.ewmaTps !== null) {
      if (!agg.running || agg.lastTs === null) return agg.ewmaTps;
      // idle 可能为负（事件 ts 领先于时钟注入源）：衰减因子夹在 [0,1]。
      const idle = Math.max(0, nowMs - agg.lastTs);
      return agg.ewmaTps * Math.min(1, Math.max(0, 1 - idle / DECAY_WINDOW_MS));
    }
    // 无 EWMA 样本（单报告轮）回退会话均速。
    return this.avgTps(agg);
  }

  private avgTps(agg: SessionAgg): number | null {
    // 实测口径优先：Σoutput / Σ生成窗口（工具执行与等待不在分母里）。
    if (agg.genMs > 0 && agg.genOutput > 0) return agg.genOutput / (agg.genMs / 1000);
    // 旧宿主 / 无可测窗口：回退首末报告墙钟跨度（含工具与等待）。
    if (agg.firstTs === null || agg.lastTs === null || agg.lastTs <= agg.firstTs) return null;
    if (agg.sumOutput <= 0) return null;
    return agg.sumOutput / ((agg.lastTs - agg.firstTs) / 1000);
  }

  private pickActive(): SessionAgg | null {
    if (this.activated && this.activated.engine) {
      const sid = this.activated.sessionId;
      if (sid) {
        const agg = this.sessions.get(`${this.activated.engine}/${sid}`);
        if (agg) return agg;
      }
    }
    // 回退「最近有流量的会话」：未收到过激活事件，或激活会话暂无数据。
    let best: SessionAgg | null = null;
    for (const agg of this.sessions.values()) {
      if (!best || agg.touched > best.touched) best = agg;
    }
    return best;
  }

  private computeSnapshot(): MeterSnapshot {
    const nowMs = this.now();
    const base = {
      ...EMPTY_SNAPSHOT,
      scope: this.config.scope,
      showSpeed: this.config.showSpeed,
      showCacheHit: this.config.showCacheHit,
    };
    if (this.sessions.size === 0) return base;

    if (this.config.scope === "active") {
      const agg = this.pickActive();
      if (!agg) return base;
      const avg = this.avgTps(agg);
      const tps = this.displayTps(agg, nowMs);
      const total = agg.sumInput + agg.sumOutput + agg.sumCacheRead + agg.sumCacheWrite;
      return {
        ...base,
        empty: total === 0 && agg.steps === 0,
        running: agg.running,
        turns: agg.turns.size,
        steps: agg.steps,
        tps,
        ewmaTps: agg.ewmaTps,
        avgTps: avg,
        modelMs: agg.genMs > 0
          ? agg.genMs
          : agg.firstTs !== null && agg.lastTs !== null
            ? agg.lastTs - agg.firstTs
            : null,
        input: agg.sumInput,
        output: agg.sumOutput,
        cacheRead: agg.sumCacheRead,
        cacheWrite: agg.sumCacheWrite,
        total,
        hasCache: agg.sumCacheRead > 0 || agg.sumCacheWrite > 0,
        cacheHitPct: formatCacheHitPercent(
          agg.sumCacheRead,
          agg.sumInput + agg.sumCacheRead + agg.sumCacheWrite,
        ),
        engine: agg.engine,
      };
    }

    // scope=all：全会话合计；速度 = 各会话展示速度之和（running 衰减、冻结保留）。
    let turns = 0,
      steps = 0,
      input = 0,
      output = 0,
      cacheRead = 0,
      cacheWrite = 0,
      tpsSum = 0,
      tpsAny = false,
      running = false,
      ewmaSum = 0,
      ewmaAny = false,
      genOutput = 0,
      genMs = 0;
    let firstTs: number | null = null;
    let lastTs: number | null = null;
    for (const agg of this.sessions.values()) {
      turns += agg.turns.size;
      steps += agg.steps;
      input += agg.sumInput;
      output += agg.sumOutput;
      cacheRead += agg.sumCacheRead;
      cacheWrite += agg.sumCacheWrite;
      genOutput += agg.genOutput;
      genMs += agg.genMs;
      const tps = this.displayTps(agg, nowMs);
      if (tps !== null) {
        tpsSum += tps;
        tpsAny = true;
      }
      if (agg.ewmaTps !== null) {
        ewmaSum += agg.ewmaTps;
        ewmaAny = true;
      }
      if (agg.running) running = true;
      if (agg.firstTs !== null && (firstTs === null || agg.firstTs < firstTs)) firstTs = agg.firstTs;
      if (agg.lastTs !== null && (lastTs === null || agg.lastTs > lastTs)) lastTs = agg.lastTs;
    }
    const total = input + output + cacheRead + cacheWrite;
    const avg =
      genMs > 0 && genOutput > 0
        ? genOutput / (genMs / 1000)
        : firstTs !== null && lastTs !== null && lastTs > firstTs && output > 0
          ? output / ((lastTs - firstTs) / 1000)
          : null;
    return {
      ...base,
      empty: total === 0 && steps === 0,
      running,
      turns,
      steps,
      tps: tpsAny ? tpsSum : avg,
      ewmaTps: ewmaAny ? ewmaSum : null,
      avgTps: avg,
      modelMs: genMs > 0
        ? genMs
        : firstTs !== null && lastTs !== null
          ? lastTs - firstTs
          : null,
      input,
      output,
      cacheRead,
      cacheWrite,
      total,
      hasCache: cacheRead > 0 || cacheWrite > 0,
      cacheHitPct: formatCacheHitPercent(cacheRead, input + cacheRead + cacheWrite),
      engine: null,
    };
  }
}
