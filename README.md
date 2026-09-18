# Token 速度表（token-meter）

CC GUI 状态栏插件：实时显示 token 输出速度（tok/s）与缓存命中率，仿
deepseek-harness 的 StatsPills 口径，支持宿主全部 11 个 CLI 引擎。

## 安装

宿主 → 设置 → 插件 → 从本地目录安装 → 选择本仓库根目录（`manifest.json` /
`main.js` / `styles.css` 三件套所在处）。改代码后 `pnpm build` 并在宿主里
重载插件。

需要宿主 SDK ≥ 0.3.8（`zone:"start"` 状态栏区域、`usage://done` /
`session://activated` 话题、payload `ts` 均自 0.3.8 起）。

## 显示

状态栏左侧（`zone:"start"`）两颗 pill：

- 速度 pill：`2 轮 2 步 · 80 tok/s`（gauge 图标）
- 用量 pill：`17K tok · 缓存命中 72%`（database 图标；引擎不报缓存字段时
  自动省略缓存段）

点击 pill 弹出详情面板（ESC / 点外部关闭）：速度面板列 轮 / 步 /
模型用时估算 / 瞬时速度（EWMA）/ 会话均速；用量面板列 未缓存输入 /
缓存读取 / 缓存写入 / 输出 / 总计。

配置（宿主设置页 → 插件 → Token 速度表，改完即生效）：

| 配置 | 默认 | 说明 |
|---|---|---|
| scope | active | active = 只显示最近激活会话；all = 全部会话合计 |
| showSpeed | true | 显示速度 pill |
| showCacheHit | true | 显示用量 pill |

## 指标口径

- **分桶 disjoint**：input（未缓存输入）、cacheRead、cacheWrite、output 互不
  重叠，总计 = 四桶之和（引擎报告 total 时取报告值）。cache 嵌在 input 内
  的协议家族（codex / DeepSeek / OpenAI 兼容 / Gemini 风格）先折出再计数——
  语义逐条复制宿主 `src/features/chat/usage.ts` 的 parseUsage 再扩超集。
- **缓存命中率** = cacheRead / (input + cacheRead + cacheWrite)；分母为 0
  隐藏；百分比取仍舍入 <100 的最小精度（照 StatsPills）。
- **tok/s** = 相邻两报告的 Δoutput/Δt（t 取 payload.ts，缺省回退到达
  时间），EWMA α=0.3 平滑；done 事件冻结（停止衰减）；running 期间无新
  报告时 10s 线性衰减到 0；单报告轮（无 EWMA 样本）回退会话均速
  Σoutput/(lastTs−firstTs)，再不行显示「—」。
- **步** = 计入的用量报告数（一报告 ≈ 一次模型响应；claude 一轮只报一次
  轮汇总，故其步数 = 轮数）；**轮** = 去重 runId 数。
- **双报去重**：grok 只经 `usage://done` 上报 → 无条件计入；其它引擎的
  done usage 仅在该 runId 此前零 usage 报告时兜底计入（claude 常规轮正是
  如此），否则只作轮结束信号——agy/qoder/dsh 的 done 回带因此不重复计数。
  携带 `total_token_usage`（会话累计字段）的 payload 走 cumulative-replace
  快照替换而非累加。

## 引擎支持矩阵

| 引擎 | 用量来源 | 计数模式 | done usage | 缓存字段 |
|---|---|---|---|---|
| claude | done（轮汇总；compact_boundary 另有占用快照） | sum | 兜底计入 | cache_read/creation_input_tokens（input 外） |
| codex | 每响应 token_usage_record | sum；带 total_token_usage 时 replace | 跳过（防双计） | cached/cache_write_input_tokens（input 内，折出） |
| kimi | 每 assistant 消息 | sum | — | prompt_tokens_details.cached_tokens（折出） |
| grok | **仅 done** | sum | 无条件计入 | 无 |
| pi / omp | 每 message_end | sum | — | cacheRead/cacheWrite（input 外） |
| dsh | 每流式 chunk（最高频） | sum | 跳过（回带末条） | prompt_cache_hit/miss_tokens（折出） |
| agy | 每 result | sum | 跳过（同份重报） | 无 |
| opencode | 每 step_finish | sum | — | cache.{read,write}（input 外） |
| qoder / qoder-cn | 每 session/prompt 结果 | sum | 跳过（回带末条） | 无 |

fixture 形状全部从宿主 Rust 发射点源码推导（逐字段对齐，文件头 `_source`
标明出处），非真实录制。

## 性能设计

- 聚合 O(1)/事件：定长扁平 SessionAgg，热路径零对象分配；250ms 尾随节流
  合并通知（dsh 洪峰安全）。
- 定时器纪律：空闲（无 running 会话）零定时器；有 running 会话单条 1s
  interval 驱动速率衰减显示，转闲即停。
- LRU 上限 100 会话，逐出最旧不活跃条目（running 豁免）。
- 面板不开不建 DOM；chip 用 `useSyncExternalStore` 订阅，宿主不轮询。
- 微基准（回归测试）：10 万条混合形状合成事件处理 **~61ms**（预算 200ms，
  Apple M2 Pro，node）。
- bundle 20.7KB 单文件 ESM，零外部 import（React 用宿主 ctx.react，
  lucide 图标 path 手工内联，ISC 许可）。

## 开发

```bash
pnpm install
pnpm validate    # manifest 校验
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest：normalize / aggregator / 微基准
pnpm build       # 仓库根产出 main.js + styles.css
```
