/**
 * 状态栏 chip：一个 item 内两颗 pill（速度 + 用量），zone:"start"。
 * 只用 ctx.react.createElement + hooks（宿主 React 树内渲染，不起第二棵
 * React 树）；useSyncExternalStore 订阅聚合器，宿主不轮询。
 */

import type { PluginContext } from "./ccgui-plugin";
import type { MeterSnapshot, UsageAggregator } from "./aggregator";
import type { Copy } from "./i18n";
import { formatTokens, formatDuration } from "./format";

// lucide 图标 path 数据手工内联（ISC 许可），禁止 import 三方包。
// gauge: https://lucide.dev/icons/gauge
const GAUGE_PATHS = ["m12 14 4-4", "M3.34 19a10 10 0 1 1 17.32 0"];
// database: https://lucide.dev/icons/database
const DATABASE_PATHS = ["M3 5V19A9 3 0 0 0 21 19V5", "M3 12A9 3 0 0 0 21 12"];

function icon(h: PluginContext["react"], kind: "gauge" | "database") {
  const children =
    kind === "gauge"
      ? GAUGE_PATHS.map((d) => h.createElement("path", { key: d, d }))
      : [
          h.createElement("ellipse", { key: "e", cx: 12, cy: 5, rx: 9, ry: 3 }),
          ...DATABASE_PATHS.map((d) => h.createElement("path", { key: d, d })),
        ];
  return h.createElement(
    "svg",
    {
      viewBox: "0 0 24 24",
      width: 16,
      height: 16,
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 2,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": true,
    },
    ...children,
  );
}

function formatTps(tps: number | null, t: Copy): string {
  return tps === null || tps < 0.5 ? "—" : `${Math.round(tps)} ${t.tokPerSec}`;
}

type PanelKind = "speed" | "usage" | null;

/** 面板行：label + value 的 dl 行。 */
function rows(h: PluginContext["react"], entries: Array<[string, string]>) {
  return h.createElement(
    "dl",
    null,
    entries.map(([label, value]) =>
      h.createElement(
        "div",
        { key: label, className: "token-meter-row" },
        h.createElement("dt", null, label),
        h.createElement("dd", null, value),
      ),
    ),
  );
}

function speedPanel(h: PluginContext["react"], snap: MeterSnapshot, t: Copy, zh: boolean) {
  return h.createElement(
    "div",
    { className: "token-meter-panel", role: "dialog", "aria-label": t.speedTitle },
    h.createElement("div", { className: "token-meter-panel-title" }, t.speedTitle),
    rows(h, [
      [t.rowTurns, String(snap.turns)],
      [t.rowSteps, String(snap.steps)],
      [
        t.rowModelTime,
        snap.modelMs === null || snap.modelMs <= 0 ? "—" : formatDuration(snap.modelMs, zh),
      ],
      [t.rowEwma, formatTps(snap.ewmaTps, t)],
      [t.rowAvg, formatTps(snap.avgTps, t)],
    ]),
  );
}

function usagePanel(h: PluginContext["react"], snap: MeterSnapshot, t: Copy) {
  return h.createElement(
    "div",
    { className: "token-meter-panel", role: "dialog", "aria-label": t.usageTitle },
    h.createElement("div", { className: "token-meter-panel-title" }, t.usageTitle),
    rows(h, [
      [t.rowInput, formatTokens(snap.input)],
      [t.rowCacheRead, formatTokens(snap.cacheRead)],
      [t.rowCacheWrite, formatTokens(snap.cacheWrite)],
      [t.rowOutput, formatTokens(snap.output)],
      [t.rowTotal, formatTokens(snap.total)],
    ]),
  );
}

export function makeStatusChip(ctx: PluginContext, agg: UsageAggregator, t: Copy) {
  const h = ctx.react;
  const zh = ctx.host.locale.startsWith("zh");
  return function TokenMeterChip() {
    const snap = h.useSyncExternalStore(agg.subscribe, agg.getSnapshot);
    const [open, setOpen] = h.useState<PanelKind>(null);
    const rootRef = h.useRef<HTMLSpanElement | null>(null);

    // ESC / 点外部关闭；面板不开不注册监听、不建 DOM。
    h.useEffect(() => {
      if (open === null) return;
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") setOpen(null);
      };
      const onDown = (e: MouseEvent) => {
        const root = rootRef.current;
        if (root && e.target instanceof Node && !root.contains(e.target)) setOpen(null);
      };
      document.addEventListener("keydown", onKey);
      document.addEventListener("mousedown", onDown);
      return () => {
        document.removeEventListener("keydown", onKey);
        document.removeEventListener("mousedown", onDown);
      };
    }, [open]);

    // 尚无数据或两颗 pill 都被配置关掉时不占位。
    if (snap.empty || (!snap.showSpeed && !snap.showCacheHit)) return null;

    const tpsText = formatTps(snap.tps, t);
    const speedLabel = `${snap.turns} ${t.turnsUnit} ${snap.steps} ${t.stepsUnit} · ${tpsText}`;
    const cacheText =
      snap.hasCache && snap.cacheHitPct !== null
        ? ` · ${t.cacheHit} ${snap.cacheHitPct}%`
        : "";
    const usageLabel = `${formatTokens(snap.total)} tok${cacheText}`;

    return h.createElement(
      "span",
      { className: "token-meter-chip", ref: rootRef },
      snap.showSpeed
        ? h.createElement(
            "button",
            {
              type: "button",
              className: `token-meter-pill${open === "speed" ? " is-open" : ""}`,
              "aria-label": t.speedAria(snap.turns, snap.steps, tpsText),
              "aria-expanded": open === "speed",
              onClick: () => setOpen(open === "speed" ? null : "speed"),
            },
            icon(h, "gauge"),
            h.createElement("span", null, speedLabel),
          )
        : null,
      snap.showCacheHit
        ? h.createElement(
            "button",
            {
              type: "button",
              className: `token-meter-pill${open === "usage" ? " is-open" : ""}`,
              "aria-label": t.usageAria(formatTokens(snap.total), snap.cacheHitPct),
              "aria-expanded": open === "usage",
              onClick: () => setOpen(open === "usage" ? null : "usage"),
            },
            icon(h, "database"),
            h.createElement("span", null, usageLabel),
          )
        : null,
      open === "speed" ? speedPanel(h, snap, t, zh) : null,
      open === "usage" ? usagePanel(h, snap, t) : null,
    );
  };
}
