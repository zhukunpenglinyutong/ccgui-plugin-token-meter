// 样式入口：宿主加载 main.js 时自动注入根 styles.css（vite 构建产物）；
// 这里 import 让 vite 把 src/styles.css 收进产物。
import "./styles.css";

import type { PluginActivate, PluginContext } from "./ccgui-plugin";
import { UsageAggregator, DEFAULT_CONFIG, type EngineEventPayloadLike } from "./aggregator";
import { copy } from "./i18n";
import { makeStatusChip } from "./ui";

/** 宿主 PluginConfigForm 的配置变更话题（payload { pluginId, key, value }，
 *  值落在插件 KV 的 config.<key>）。 */
const CONFIG_CHANGED_TOPIC = "plugin-config://changed";

/** 从插件 KV 读 configSchema 三配置项（宿主设置页写入 config.<key>）。 */
async function loadConfig(ctx: PluginContext, agg: UsageAggregator): Promise<void> {
  const [scope, showSpeed, showCacheHit] = await Promise.all([
    ctx.storage.get<string>("config.scope"),
    ctx.storage.get<boolean>("config.showSpeed"),
    ctx.storage.get<boolean>("config.showCacheHit"),
  ]);
  agg.setConfig({
    scope: scope === "all" ? "all" : scope === "active" ? "active" : DEFAULT_CONFIG.scope,
    showSpeed: showSpeed ?? DEFAULT_CONFIG.showSpeed,
    showCacheHit: showCacheHit ?? DEFAULT_CONFIG.showCacheHit,
  });
}

const activate: PluginActivate = (ctx) => {
  const t = copy(ctx.host.locale);
  const agg = new UsageAggregator();
  void loadConfig(ctx, agg);

  ctx.events.on("usage://updated", (data) =>
    agg.onUsageEvent(data as EngineEventPayloadLike),
  );
  ctx.events.on("usage://done", (data) => agg.onDoneEvent(data as EngineEventPayloadLike));
  ctx.events.on("session://activated", (data) =>
    agg.onSessionActivated(data as { engine: string | null; sessionId: string | null }),
  );
  // 设置页改配置 → 即读即生效（只收本插件的变更）。
  ctx.events.on(CONFIG_CHANGED_TOPIC, (data) => {
    const d = data as { pluginId?: string; key?: string; value?: unknown };
    if (d.pluginId !== ctx.pluginId) return;
    if (d.key === "scope") agg.setConfig({ scope: d.value === "all" ? "all" : "active" });
    else if (d.key === "showSpeed") agg.setConfig({ showSpeed: Boolean(d.value) });
    else if (d.key === "showCacheHit") agg.setConfig({ showCacheHit: Boolean(d.value) });
  });

  // Composer 状态行（分支/上下文用量那行）左组，SDK 0.3.9 起；宿主
  // 更旧时 ui:composer-status 未入 spec，安装在权限校验期即拒绝，无需
  // 运行时回退。
  ctx.ui.registerComposerStatusItem({
    component: makeStatusChip(ctx, agg, t),
  });

  return () => agg.dispose();
};

export default activate;
