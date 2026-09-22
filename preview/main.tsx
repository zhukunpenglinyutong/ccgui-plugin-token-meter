import * as React from "react";
import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
/* 宿主完整 CSS（真实 token，含 .dark 翻转）在前，插件样式在后——与宿主
 * 实际加载顺序一致。 */
import "../../../desktop-cc-gui/src/index.css";
import "../src/styles.css";
import claude from "../fixtures/claude-usage.json";
import { UsageAggregator, type EngineEventPayloadLike } from "../src/aggregator";
import { copy } from "../src/i18n";
import { makeStatusChip } from "../src/ui";
import type { PluginContext } from "../src/ccgui-plugin";

/**
 * 视觉验证页：真实 status chip + 面板，喂罐头 usage 事件（claude 口径），
 * 浅色显示速度面板、深色显示用量面板。
 */

function usage(runId: string, ts: number): EngineEventPayloadLike {
  return { runId, sessionId: "s1", engine: "claude", kind: "usage", data: claude, ts } as EngineEventPayloadLike;
}

const agg = new UsageAggregator({ trailingMs: 120 });
agg.setConfig({ scope: "active", showSpeed: true, showCacheHit: true });
// 3 次 usage ≈ 2 轮 3 步，跨度 ~4s：输出 900 tok → ~200+ tok/s 的合理数字。
const t0 = Date.now() - 4200;
agg.onUsageEvent(usage("r1", t0));
agg.onUsageEvent(usage("r1", t0 + 1400));
agg.onUsageEvent(usage("r2", t0 + 4000));

const ctx = { react: React, host: { locale: "zh-CN" } } as unknown as PluginContext;
const Chip = makeStatusChip(ctx, agg, copy("zh-CN"));

function Scene({ dark, open }: { dark?: boolean; open: "speed" | "usage" }) {
  const chipRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // 面板是组件内部状态：用一次真实点击驱动，pill 选中态与面板同时出现。
    const target = chipRef.current?.querySelectorAll<HTMLButtonElement>("button.token-meter-pill")[
      open === "speed" ? 0 : 1
    ];
    const id = window.setTimeout(() => target?.click(), 150);
    return () => window.clearTimeout(id);
  }, [open]);

  return (
    <div
      className={dark ? "dark" : undefined}
      style={{
        background: "var(--color-background-secondary-default)",
        padding: "20px 32px 28px",
        minHeight: 440,
      }}
    >
      {/* 面板绝对定位于 chip 上方，顶部留出它的高度。 */}
      <div style={{ maxWidth: 720, margin: "0 auto", paddingTop: 228 }}>
        <div
          style={{
            background: "var(--color-background-primary-default)",
            border: "1px solid var(--color-separator-border)",
            borderRadius: 16,
            boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
            padding: "14px 16px 10px",
          }}
        >
          <div style={{ color: "var(--color-text-primary)", fontSize: 14, lineHeight: "22px" }}>
            帮我把登录流程的边界条件过一遍，顺便看看 token 花在哪了
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginTop: 10,
              height: 26,
            }}
          >
            <div ref={chipRef} style={{ display: "inline-flex" }}>
              <Chip />
            </div>
            <span style={{ color: "var(--color-text-tertiary)", fontSize: 12 }}>
              claude · 上下文 12%
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr" }}>
      <Scene open="speed" />
      <Scene dark open="usage" />
    </div>
  </React.StrictMode>,
);
