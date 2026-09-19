# Toonflow：Custom（GPT Image 2 / Gemini 3.1 Pro）

> 说明：本文中的 `adapters/` 命令属于历史验证记录。外层验证脚本已清理，当前可发布代码和维护脚本必须放在 `Toonflow-app/` 或对应工程中；历史结果仍保存在 `artifacts/`。

Merlin H3 视频接入见 [H3 代码与说明](merlin-minimax-h3.md)，独立供应商代码为 [FL2VA](../data/vendor/merlinminimaxh3fl2va.ts) 和 [Ref2VA](../data/vendor/merlinminimaxh3ref2va.ts)。

`../data/vendor/aidpgptimage.ts` 是完整供应商文件，独立 ID 为 `aidpgptimage`。2.9 版参考图上传依赖本项目后端新增的 `postImageMultipart` 帮助函数，安装前须同时更新 `src/lib/imageMultipart.ts`、`src/utils/vm.ts`，构建并重启后端；仅粘贴供应商文件到未更新的 Toonflow 会提示更新后端。`aidp-image-request.ts` 和 `aidp-text-request.ts` 分别是图片及文本函数片段，供阅读或局部修改。

## 在界面中使用

1. 已有此供应商时，进入该供应商的“编辑代码”，粘贴 `Toonflow-app/data/vendor/aidpgptimage.ts` 全部内容并保存。仅首次安装才使用“添加供应商 → 通过代码添加”，避免 ID 重复。
2. 选择“Custom”供应商；若尚未出现，刷新页面并重新打开设置。原供应商显示名称已更改，内部 ID 仍为 `aidpgptimage`，保留已有模型映射。
3. 在设置页填写下表，开启供应商。AK 只填在界面中，无需写入代码。
4. 模型列表包含 GPT Image 2（标识 `gpt-image-2`，类型 `image`，三种模式均列出）和 Gemini 3.1 Pro（标识 `gemini-3.1-p`，类型 `text`，思考开启）。图片参考模式的实际限制见下方验证范围。
5. 点击相应模型“测试”；要用于剧本等文本任务，还需在模型配置中将对应任务选择为 Gemini 3.1 Pro。真实调用会产生平台用量。

| 设置 | 填写值 |
| --- | --- |
| AIDP AK | 对目标模型及区域有权限的 AK |
| 文本及文生图基础地址 | `https://aidp.bytedance.net/api/modelhub/online/v2/crawl/openai/deployments/gpt_openapi` |
| 参考图请求基础地址 | `https://aidp.bytedance.net/gpt/openapi/online/v2/crawl/openai` |
| 图片分辨率 | 在生图界面选择 `1K` / `2K` / `4K`，实际尺寸与质量见下表；未传档位时默认 `2K` |
| 图片画幅 | 按用户要求，所有档位固定 `16:9` |

2.8 版已预填上述地址。旧安装保留已保存的 AK 和请求地址；旧 `imageSize` / `imageQuality` 固定配置不再生效，也不再显示这两个供应商输入项。图片模型名使用 `gpt-image-2`，文本模型名使用 `gemini-3.1-p`。

文生图请求 `baseUrl + /images/generations`；单图及多图参考请求独立的 `editBaseUrl + /images/edits`。参考图地址使用已验证的 GPT OpenAPI 入口，不能填原 ModelHub 部署入口。这样 Gemini 仍可复用已有的 ModelHub 文本配置。

供应商 ID 必须唯一。旧版文件的 `id: "null"` 与内置空模板重复，仅适合在空模板的“编辑代码”中使用。当前文件用于新增独立供应商；添加成功后再次修改代码，应进入“Custom”的“编辑代码”，不要重复添加同一 ID。若选择替换已有空模板，需将 ID 改回 `null`。

保存已有供应商的代码会用代码中的模型列表更新现有列表，请保留需要的其他模型及相应请求函数。本完整文件提供图片及文本模型。

供应商代码由后端每次调用时读取；仅修改供应商代码无需重新构建或重启。2.9 版首次安装还涉及上述后端帮助函数，因此需要构建并重启一次。

## 请求逻辑

### 文本

- 复用同一 `baseUrl` 和 AK，通过 Toonflow 已有的 OpenAI Compatible SDK 向 `baseUrl + /chat/completions` POST JSON。此部署路由已实测可调用 `gemini-3.1-p`；不是直接请求 curl 示例中的裸 `/v2/crawl` 路由。
- AK 通过 `api-key` 请求头传递，并附带 `X-TT-LOGID`；不把 AK 放进文本请求 URL。
- SDK 负责传递 `messages`、工具定义和工具结果，解析普通响应及 SSE 流式响应。`stream` 与 Toonflow 的调用方式一致。
- 2.7 版针对 Gemini 移除工具 `function.parameters` 根节点的 `$schema` 文档版本声明；保留业务属性、嵌套类型、枚举和必填约束。该字段由 Toonflow 使用的 Zod `toJSONSchema()` 自动添加，AIDP 转成 Gemini `function_declarations[].parameters` 后会引发 400。此处理不会修改业务层共享 schema 或其他模型的请求。
- 使用 SDK 的原始响应元数据提取接口，保存 AIDP 返回的消息级及工具级 `signature`，按 tool call ID 原样补回后续工具结果请求。普通响应、流式晚到签名及并行工具分别处理；签名缓存只存在于当前模型调用链中，日志不记录签名。
- 2.5 版将 Toonflow 四种选择映射为不同的 AIDP `thinking.budget_tokens`，不再统一使用 2000。预算配置保留在代码中，不在供应商设置页显示。

  | 界面选择 | think / thinkLevel | include_thoughts | budget_tokens | 默认 max_tokens |
  | --- | --- | --- | --- | --- |
  | 关闭思考 | false / 0 | false | 0 | 4096 |
  | 轻度思考 | true / 1 | true | 1024 | 5120 |
  | 深度思考 | true / 2 | true | 8192 | 12288 |
  | 极致思考 | true / 3 | true | 24576 | 28672 |

- 默认总输出上限为思考预算加 4096，为最终回答预留空间。任务显式设置 `maxOutputTokens` 时仍优先采用任务配置；若设置过小，可能在思考期间达到总上限并截断回答。
- 通用 AI 等调用只开启思考而未指定档位（`think=true, thinkLevel=0`）时默认轻度。聊天界面的关闭选项会传 `think=false`；关闭开关或模型标记为不支持思考时，预算固定为 0。
- 上述为当前 AIDP 旧入口的应用侧预算，不宣称与 Gemini 原生档位一一等价。Google 推荐 Gemini 3 使用 `thinkingLevel: low / medium / high`，预算参数仅为兼容。后续排查签名时找到的 [AIDP Gemini 文档](https://bytedance.larkoffice.com/wiki/XlkuwCfY6i1KCkkiMLZc5zCXnib) 已列出 `thinking.thinking_level`，并要求它与 `budget_tokens` 二选一；本次工具兼容修复继续保留已实测的四档预算配置，没有同时发送这两个字段。参见 [Google 思考配置](https://ai.google.dev/gemini-api/docs/generate-content/thinking#thinking-levels-gemini-3)。
- Gemini 3.1 Pro 不支持完全关闭内部推理。“关闭思考”发送 `include_thoughts: false, budget_tokens: 0`，不保证返回的内部推理 token 为零。各档位预算也不是每次必须消耗的 token 数。

### 图片

- 无参考图：向 `baseUrl + /images/generations` POST JSON。
- 有参考图：向 `editBaseUrl + /images/edits` POST multipart/form-data，单图及多图均使用重复的 `image[]` 文件字段，保留原始 PNG/JPEG/WebP 字节、顺序和 MIME。
- 2.9 版使用 Toonflow 注入的 `postImageMultipart`：沙盒只传递 JSON 字符串，宿主进程解码 data URL、构造 FormData 并上传；只返回响应状态和 JSON 数据，避免大块 Buffer、FormData 及 Axios 配置跨 VM2 边界引发逐字节检查。处理参考图之间让出事件循环，表单自动生成 boundary。原图不压缩、不缩放。
- 图片请求均包含 `model`、`prompt`、`n: 1`、`size`、`quality`；AK 作为查询参数 `ak` 发送，附带 `X-TT-LOGID` 便于排查。
- 将 `data[0].b64_json` 包装成 Toonflow 要求的图片 data URL；也兼容返回图片 URL 后下载。
- 请求超时为 300 秒，没有自动重试。日志不打印 AK 或参考图，错误信息会过滤 AK。

2.8 版将 Toonflow 生图界面的档位（`config.size`）映射为实际 API 像素尺寸和质量。按用户要求，所有图片输出固定为 **16:9**，调用方的其他 `aspectRatio` 不改变输出画幅。文生图 JSON、单图和多图参考 multipart 使用相同映射：

| 界面档位 | 实际 `size` | 实际 `quality` |
| --- | --- | --- |
| 1K | `1280x720` | `low` |
| 2K | `2048x1152` | `medium` |
| 4K | `3840x2160` | `high` |

缺少档位时默认 2K / medium；未知档位在发请求前报错。尺寸直接交给模型生成，不在本地裁剪或放大。请求日志包含档位、实际尺寸、质量、参考图数量及 logID，便于确认界面参数确实生效。该版本没有蒙版输入。

尺寸依据 [OpenAI GPT Image 2 官方约束](https://developers.openai.com/api/docs/guides/image-generation#earlier-gpt-image-models)：两边都是 16 的倍数，最长边不超过 3840，总像素在 655,360～8,294,400 之间。`1024x576` 低于最小像素数，因此 1K 宽屏档采用 `1280x720`；4K 采用 `3840x2160`，不会请求 `4096x2304`。

## 验证范围

2026-09-12，2.9 版修复分镜参考图准备阶段导致整个页面卡顿的问题。相同 5 张实际资产、5 个并发，在模拟 AIDP 响应时，本地准备总耗时从 26,542 ms 降至 245 ms，事件循环计时器延迟从 26,542 ms 降至 232 ms；该测量不包含远端生图。25 项适配及性能测试、后端 TypeScript 检查和构建通过。后端在没有进行中任务时完成重启，首页 HTTP 200，任务列表刷新正常。参见 [性能排查与复测报告](../../artifacts/toonflow-performance-tests/2026-09-12-image-prep/README.md)。回归命令：`/usr/local/bin/node --test adapters/test-aidp-image-request.cjs adapters/test-aidp-text-request.cjs adapters/test-aidp-image-performance.cjs`。超时仍为 300 秒，不自动重试，三档尺寸、质量和固定 16:9 均保持不变。

2026-09-12，2.8 版已安装，所有图片档位固定 16:9。24 项本地测试通过，覆盖界面档位映射、旧供应商配置不再覆盖、JSON/multipart 参数一致、真实本地 HTTP 表单传输以及 Gemini 工具与思考回归。真实 AIDP 调用已解码确认：1K 文生图 `1280x720` / low，2K 单参考图 `2048x1152` / medium，4K 多参考图 `3840x2160` / high。4K 首次遇到上游资源不足 429，单独人工复测成功；应用没有增加自动重试。参见 [尺寸与质量实测报告](../../artifacts/aidp-reference-tests/2026-09-11T16-38-10-549Z/README.md)。复现：`node adapters/test-aidp-image-live.cjs --run --resolution-probe`；仅复测 4K 时加 `--case 4k-multi-reference`。测试只输出到 artifacts，不修改项目资产或分镜数据。

2026-09-11，2.7 版已安装到当前 Toonflow，修复 Gemini 工具 schema 400 及后续签名回传 400。原始生产决策层 14 个工具定义复现报错后，已验证修复后的两轮真实调用；另携带生产、剧本、技能共 20 个真实工具定义，并使用 Toonflow 相同的 reasoning middleware，验证了工作区读取、工具结果回传和最终回答。22 项本地适配测试通过。详见 [Gemini 工具调用修复报告](../../artifacts/aidp-text-tests/2026-09-11-gemini-tool-schema/README.md)。复现命令：`node adapters/test-aidp-text-live.cjs --run --tools` 或 `--all-tools`，仅执行连接内存样例的工作区读取工具。

2026-09-11，2.5 版已通过 Toonflow 设置 API 安装；关闭、轻度、深度、极致四种选择各发出一次真实流式调用，均 HTTP 200 并正常返回。16 项适配测试通过。四档实测验证请求参数和接口兼容性，简单题不用于推断复杂任务的推理深度差异。详见 [四档思考配置与实测](../../artifacts/aidp-text-tests/2026-09-11T15-44-49-451Z/README.md)。复现命令：`node adapters/test-aidp-text-live.cjs --run --thinking-levels`。

2026-09-11，2.4 版已通过 Toonflow 设置 API 安装并启用，默认质量 medium、尺寸 1536x1024。Toonflow 实际模型测试接口的单图调用、已安装供应商的多图调用均返回目标尺寸并保留参考主体；多图版式仍有重排。13 项适配测试通过。详见 [配置与实测报告](../../artifacts/aidp-reference-tests/2026-09-11T15-21-07-254Z-toonflow-config/README.md)。

使用 Toonflow 本地 Sucrase + VM2 运行完整文件，校验文生图、单图、多图、返回值和失败处理，并通过本地 HTTP 接收端验证真实 Axios + FormData 传出的图片字节、字段、boundary 和鉴权。运行：`node --test adapters/test-aidp-image-request.cjs`。

文本适配使用真实 AI SDK + VM2 和模拟 HTTP 校验普通响应、流式响应、工具调用及思考参数。运行全部适配测试：`node --test adapters/test-aidp-image-request.cjs adapters/test-aidp-text-request.cjs`。

2026-09-11 的早期文本测试使用已安装供应商和已保存 AK，分别发送一次非流式及流式文本请求，两次均 HTTP 200，`gemini-3.1-p` 对“只回答 1+1 的计算结果”均返回 `2`。详见 [早期文本实测记录](../../artifacts/aidp-text-tests/2026-09-11T13-53-04-579Z/report.json)。需要重复普通文本真实验证时运行 `node adapters/test-aidp-text-live.cjs --run`；它会产生两次平台调用。当时工具调用仅做了模拟验证，2.7 版已补充上方的真实工具调用验证。

2026-09-11 的早期 JSON 接入先向 `/images/edits` 发送 5 次真实请求，后改用 `/images/generations` 重跑 3 次对照。两轮均返回 HTTP 200 和图片，但参考保真检查均未通过；仅切换 path 未解决参考内容丢失。详见 [真实测试报告](../../artifacts/aidp-reference-tests/README.md)。

随后按用户提供的 curl 示例测试 `/gpt/openapi/online/v2/crawl/openai/images/edits` + multipart `image[]`，确认单图及多图参考内容均生效，多图版式仍有重排。2.4 版已采用该协议；未增加 mask 输入。详见 [multipart 实测报告](../../artifacts/aidp-reference-tests/2026-09-11T14-53-31.299Z-multipart/README.md)。

固定 low、1024x1024 后又完成入口与格式交叉对照：旧 generations JSON 仍失败；GPT OpenAPI edits 的当前 JSON 结构明确报缺少 image，而 multipart 再次保留参考内容。旧 ModelHub edits multipart 返回空响应。详见 [固定参数对照报告](../../artifacts/aidp-reference-tests/2026-09-11-route-format-comparison/README.md)。测试脚本支持 `--endpoint`、`--request-format`、`--case` 指定单个组合。

当前适配依据实测分别使用 ModelHub 的文本／文生图接口和 GPT OpenAPI 的 multipart 编辑接口，并未适配 [ModelHub 统一协议](https://bytedance.larkoffice.com/wiki/RP51wPyj1i6Yi8kHRV4ck44Onw2)中的 `unified/v1` 路由。
