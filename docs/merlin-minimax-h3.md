# Toonflow：本地 Merlin H3

> 说明：本文中的 `adapters/` 命令属于历史验证记录。外层验证脚本已清理，当前可发布代码和维护脚本必须放在 `Toonflow-app/` 或对应工程中；历史结果仍保存在 `artifacts/`。

当前仅保留并启用两个供应商，旧的 `Merlin MiniMax H3` 已删除，已有项目的旧 Ref2VA 配置已迁移。

| 供应商／模型 | 支持输入 | Merlin 服务 |
| --- | --- | --- |
| Merlin H3 · FL2VA / MiniMax H3 · FL2VA | 首帧和尾帧均可选：零张、仅首帧、仅尾帧、两帧 | `zj-minimax-h3-fl2va` |
| Merlin H3 · Ref2VA / MiniMax H3 · Ref2VA | 1–8 张参考图，或一段参考视频；不能混用 | `zj-minimax-h3-rel2va` |

## 使用

1. 从工作区运行 `./start-merlin-h3.command` 和 `./start-toonflow.command`。
2. 刷新 Toonflow 页面，在项目或视频工作台选择对应供应商下的模型。
3. FL2VA 选择“首尾帧（均可选）”，按需要在首帧、尾帧槽位放图；不放图时由本地 API 使用 T2VA，仍走同一条 shared 通道。
4. Ref2VA 选择图片参考，上传 1–8 张；模型测试页中的“图片 ×8”表示上限，不要求凑满 8 张。视频参考限一段。
5. 选择 768P、4–15 秒。模型原生生成音频。初次建议用 4 秒验证。

| 供应商设置 | 默认值 |
| --- | --- |
| 本地 H3 服务地址 | `http://127.0.0.1:18081` |
| 推理步数 | `20`，可填写任意正整数，例如 `30`；留空使用默认值 |
| 等待任务完成的分钟数 | `120`，包括排队和推理 |

两者共用本地 API，无需 API Key。通过本地 Worker 直接调用 Merlin Pod，不经过远程 Portal 或开发机；模型权重和 GPU 推理仍在 Merlin。

5.1 版移除 5/20/50 固定档位，供应商和本地 API 只校验正整数，任务列表及详情显示实际步数。升级时须同步更新本地服务并重启 API；已有供应商配置继续保留，留空默认 20 步。

## 代码与协议

- 共用协议实现：`scripts/templates/merlin-minimax-h3.ts`，作为构建模板使用。
- 可独立安装的供应商：`data/vendor/merlinminimaxh3fl2va.ts`、`data/vendor/merlinminimaxh3ref2va.ts`。
- 修改共用实现后运行 `node Toonflow-app/scripts/build-merlin-h3-channels.cjs` 生成两份供应商代码，再通过 Toonflow 的“编辑代码”更新对应供应商。
- 安装 ID：`merlinminimaxh3fl2va`、`merlinminimaxh3ref2va`；模型 ID：`MiniMax-H3-FL2VA`、`MiniMax-H3-Ref2VA`。
- 发送给本地 Portal 的模型字段仍为 `MiniMax-H3`。先上传素材得到 `asset://...`，再创建任务、轮询状态，最后下载本地 MP4。
- 首尾帧使用显式 `first_frame` / `last_frame` 角色，单次生成、批量生成和模型测试均保留角色；空槽位不会把尾帧前移成首帧。
- 两个供应商限制各自允许的模式，错误模式会在上传前拒绝，不会切换到另一条通道。
- 工作台单段、批量生成会在首次提交前，把请求和幂等键保存到 `o_tasks.relatedObjects.h3`。提交响应丢失时使用原请求、原幂等键重试；拿到任务编号后只查询原任务。超过 23 小时仍无法确认提交的请求保留待核对状态，避免超过服务端的 24 小时幂等保护期后重复生成。
- 后端每 5 秒扫描待同步任务，正常任务约每 10 秒查询一次，最多四个同步请求并发；网络异常按 5–60 秒退避重试。关闭页面或重启 Toonflow 后会继续同步。只有 H3 明确失败/取消或拒绝提交才标记生成失败；MP4 写入本地后，在同一数据库事务中更新视频和任务为成功。
- 供应商模型测试仍使用直接轮询，短暂网络异常会继续查询原任务；失败或超时保留任务编号。已有旧版本报错任务应先按编号核对并关联远端任务，不能全部重新生成。

4.1 版将参考图片、参考视频的解码与 multipart 上传放在后端宿主中执行，只让字符串穿过供应商沙盒，避免 VM2 逐字节检查二进制对象导致整页卡顿。大段 Base64 单独传入，不再为上传反复复制到 JSON 中。原始文件字节、真实 MIME、首尾帧角色、任务幂等键及轮询协议保持不变。

首次安装 4.1 须同时更新 `Toonflow-app/src/lib/mediaUpload.ts` 和 `src/utils/vm.ts`，构建并重启后端，再安装两份 4.1 供应商代码。仅在旧后端中安装新供应商会提示更新后端。重启前应等待进行中的 Toonflow 任务结束，避免中断结果回写。

前端源码位于新建的 `Toonflow-web/`。新增 `startEndOptional` 模式，构建产物已更新到 `Toonflow-app/data/web/`；后端也已构建并重启。刷新浏览器以加载新模式，普通供应商配置更新本身无需重启。

## 验证

2026-09-12，4.1 版在模拟远端生成的条件下，5 张实际分镜首帧的五并发调用从 10,972 ms 降为 33 ms；62 段、每段 2 MiB 首帧的总准备耗时 185 ms，最大计时器延迟 131 ms。75 项功能及图片性能回归通过，视频性能回归另通过实际五图和 62 段测试；后端类型检查和构建通过。详见 [视频批量生成性能报告](../../artifacts/toonflow-performance-tests/2026-09-12-video-prep/README.md)。这些数据衡量本地准备及模拟返回，不包括 Merlin 推理或排队耗时。

```bash
node --test adapters/test-merlin-minimax-h3.cjs adapters/test-toonflow-video-references.cjs adapters/test-toonflow-video-duration.cjs
H3_PERF_CONCURRENCY=62 node --test adapters/test-merlin-h3-performance.cjs
```

```bash
node --test adapters/test-merlin-minimax-h3.cjs adapters/test-toonflow-video-references.cjs
```

持久任务同步回归测试（使用与 Toonflow 原生 SQLite 模块匹配的 Node.js，本机为 `/usr/local/bin/node`）：

```bash
/usr/local/bin/node --test adapters/test-h3-video-sync.cjs
```

测试使用临时 SQLite 和本地 HTTP 服务，覆盖查询断线、提交响应丢失、重建同步器、同键重试、下载/写盘/数据库事务失败、远端终态、并发限制及实际工作台供应商调用链，不触发远端推理。

32 项测试通过，覆盖四种首尾帧组合、帧角色、1/2/8 张参考图、9 张拒绝、跨通道拒绝、multipart 上传、任务轮询、MP4 下载、失败与超时。

本地服务端已验证多图绑定、8 张上限、混合素材拒绝，以及 Worker 将多张图作为多个 `input_references` 发送；原服务端的仅首帧／仅尾帧映射保持通过。Toonflow 后端类型检查、构建及供应商 TypeScript 检查通过；前端 Vite 生产构建通过。

前端仓库原有的未使用文件 `generate copy.vue:1063` 存在语法错误，完整 `yarn build` 中的 vue-tsc 因此失败。本次使用 `yarn build-only` 构建实际引用的页面；新增参考素材处理函数已单独通过类型检查与行为测试。没有修改该旧文件。

真实验证结果见 `../../artifacts/h3-live-validation/README.md`。本机当前 Ref2VA 可以发现推理实例，FL2VA/shared 尚未发现可用推理实例；以 `http://127.0.0.1:18081/readyz` 和各任务状态为准。
