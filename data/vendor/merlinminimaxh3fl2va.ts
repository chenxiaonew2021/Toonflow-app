// 由 scripts/build-merlin-h3-channels.cjs 生成；模板位于 scripts/templates/merlin-minimax-h3.ts。
/** Toonflow 2.x 供应商：调用独立 merlin-h3-service 的本地 V2 任务 API。 */
type Reference = { type: "image" | "video" | "audio"; base64: string; role?: "first_frame" | "last_frame" };
type VideoConfig = {
  prompt: string;
  duration: number;
  resolution: string;
  aspectRatio: string;
  audio?: boolean;
  mode: string | (string | string[])[];
  referenceList?: Reference[];
};
declare const axios: any;
declare const FormData: any;
declare const uploadMediaFile: (dataUrl: string, requestJson: string) => Promise<string>;
declare const crypto: { randomUUID(): string };
declare const logger: (message: string) => void;
declare const urlToBase64: (url: string) => Promise<string>;
declare const pollTask: (fn: () => Promise<{ completed: boolean; data?: string; error?: string }>, interval: number, timeout: number) => Promise<{ completed: boolean; data?: string; error?: string }>;
declare const queueH3Task: ((requestJson: string) => Promise<string>) | undefined;
declare const exports: Record<string, any>;

const vendor = {
  "id": "merlinminimaxh3fl2va",
  "version": "5.1",
  "name": "Merlin H3 · FL2VA",
  "author": "Local",
  "description": "本地直连 zj-minimax-h3-fl2va。首帧、尾帧均可选：不传图、仅首帧、仅尾帧或两帧都传。无图时使用 T2VA。768P，4–15 秒，原生音画生成。",
  "inputs": [
    {
      "key": "baseUrl",
      "label": "本地 H3 服务地址",
      "type": "url",
      "required": true,
      "placeholder": "http://127.0.0.1:18081"
    },
    {
      "key": "inferenceSteps",
      "label": "推理步数（正整数）",
      "type": "text",
      "required": false,
      "placeholder": "20"
    },
    {
      "key": "timeoutMinutes",
      "label": "等待任务完成的分钟数",
      "type": "text",
      "required": false
    }
  ],
  "inputValues": {
    "baseUrl": "http://127.0.0.1:18081",
    "inferenceSteps": "20",
    "timeoutMinutes": "120"
  },
  "models": [
    {
      "name": "MiniMax H3 · FL2VA",
      "modelName": "MiniMax-H3-FL2VA",
      "type": "video",
      "mode": [
        "startEndOptional"
      ],
      "audio": true,
      "durationResolutionMap": [
        {
          "duration": [
            4,
            5,
            6,
            7,
            8,
            9,
            10,
            11,
            12,
            13,
            14,
            15
          ],
          "resolution": [
            "768P"
          ]
        }
      ]
    }
  ]
};

// 把 Axios 错误转换为普通错误，避免 Toonflow 日志输出包含参考素材的请求配置。
function describeError(error: any): string {
  const detail = error?.response?.data?.detail;
  if (Array.isArray(detail)) return detail.map((item: any) => `${(item.loc || []).join(".")}: ${item.msg}`).join("；");
  if (detail?.message) return `${detail.code || "portal_error"}: ${detail.message}`;
  if (typeof detail === "string") return detail;
  if (error?.response?.status) return `HTTP ${error.response.status}`;
  return error?.code || (error instanceof Error ? error.message : "网络请求失败");
}

function prepareMedia(ref: Reference) {
  let dataUrl = ref.base64?.trim() || "";
  if (!dataUrl.startsWith("data:")) {
    const mime = ref.type === "video" ? "video/mp4"
      : dataUrl.startsWith("iVBOR") ? "image/png"
      : dataUrl.startsWith("/9j/") ? "image/jpeg"
      : dataUrl.startsWith("UklGR") ? "image/webp" : "";
    if (!mime) throw new Error("参考图片必须是 PNG、JPEG 或 WebP Base64");
    dataUrl = `data:${mime};base64,${dataUrl}`;
  }
  const match = /^data:(image\/(?:png|jpeg|webp)|video\/mp4);base64,([A-Za-z0-9+/\s]+={0,2})$/.exec(dataUrl);
  if (!match || !match[1].startsWith(`${ref.type}/`)) throw new Error("参考素材格式不正确；图片支持 PNG/JPEG/WebP，视频支持 MP4");
  // Native Base64 decoding accepts whitespace; avoid copying the full payload.
  return { dataUrl, mime: match[1] };
}

const videoRequest = async (config: VideoConfig, model: { modelName: string }): Promise<string> => {
  const root = vendor.inputValues.baseUrl?.trim().replace(/\/+$/, "").replace(/\/v2(?:\/video_generation)?$/, "");
  if (!/^https?:\/\/[^\s/?#]+$/.test(root)) throw new Error("请填写本地 H3 服务根地址，如 http://127.0.0.1:18081");
  const channel = model.modelName === "MiniMax-H3-FL2VA" ? "FL2VA"
    : model.modelName === "MiniMax-H3-Ref2VA" ? "Ref2VA" : null;
  if (!channel || !vendor.models.some(item => item.modelName === model.modelName)) throw new Error("请选择当前供应商提供的 H3 模型");
  if (!config.prompt?.trim() || config.prompt.length > 7000) throw new Error("视频提示词须为 1–7000 个字符");
  if (config.resolution !== "768P") throw new Error("当前 H3 Portal 仅支持 768P");
  if (!Number.isInteger(config.duration) || config.duration < 4 || config.duration > 15) throw new Error("视频时长须为 4–15 秒的整数");
  if (!["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"].includes(config.aspectRatio)) throw new Error("不支持的视频画幅");
  if (config.audio === false) throw new Error("该 Portal 提供原生音画生成，不支持关闭音频；如需静音请在生成后处理");
  const steps = Number(vendor.inputValues.inferenceSteps?.trim() || "20");
  const minutes = Number(vendor.inputValues.timeoutMinutes?.trim() || "120");
  if (!Number.isInteger(steps) || steps < 1) throw new Error("推理步数须为正整数");
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) throw new Error("等待时长须为 1–1440 分钟");

  let selected: VideoConfig["mode"] = config.mode;
  if (typeof selected === "string" && selected.trim().startsWith("[")) selected = JSON.parse(selected);
  const modes = Array.isArray(selected) ? selected.flat() : [selected];
  if (modes.length !== 1) throw new Error("请选择一个生成模式；参考图片和参考视频不能混用");
  const mode = modes[0];
  const allowedModes = channel === "FL2VA" ? ["startEndOptional"] : ["imageReference:8", "videoReference:1"];
  if (!allowedModes.includes(mode)) throw new Error(`${channel} 模型不支持此生成模式，请选择对应通道的模型和模式`);
  const refs = config.referenceList || [];
  let roles: string[];
  if (mode === "startEndOptional") {
    if (refs.length > 2) throw new Error("首尾帧最多两张，首帧和尾帧均可不传");
    // 不能按过滤后的数组顺序猜首尾帧：只传尾帧时也必须保留 last_frame。
    roles = refs.map(ref => ref.role || "");
    if (roles.some(role => !["first_frame", "last_frame"].includes(role)) || new Set(roles).size !== roles.length) {
      throw new Error("首尾帧需带唯一的 first_frame / last_frame 角色，请刷新 Toonflow 后重新选择素材");
    }
  } else if (mode === "imageReference:8") {
    if (refs.length < 1 || refs.length > 8) throw new Error("Ref2VA 需要 1–8 张参考图片");
    roles = refs.map(() => "reference_image");
  } else {
    if (refs.length !== 1) throw new Error("视频参考模式需要一段参考视频");
    roles = ["reference_video"];
  }
  const media = refs.map((ref, index) => {
    const kind = roles[index] === "reference_video" ? "video" : "image";
    if (ref.type !== kind) throw new Error(`第 ${index + 1} 个参考素材须为 ${kind === "image" ? "图片" : "视频"}`);
    return prepareMedia(ref);
  });
  if (media.length && typeof uploadMediaFile !== "function") throw new Error("请更新并重启 Toonflow 后端以启用视频参考素材上传优化");

  const idempotencyKey = crypto.randomUUID();
  let taskId = "";
  try {
    const content: Record<string, any>[] = [{ type: "text", text: config.prompt }];
    // Portal 不接受 data URL 或外部图片 URL：先上传，再把 asset://... 写进 content。
    for (let i = 0; i < media.length; i++) {
      const item = media[i];
      // 只让字符串跨沙盒；解码、FormData 和 Axios 二进制配置留在宿主进程。
      const upload = JSON.parse(await uploadMediaFile(item.dataUrl, JSON.stringify({
        url: `${root}/v2/uploads`,
        filename: `reference-${i + 1}.${item.mime.split("/")[1]}`, timeout: 120000,
      })));
      if (upload.status < 200 || upload.status >= 300) throw { response: upload };
      const assetUrl = upload.data?.url;
      if (typeof assetUrl !== "string" || !/^asset:\/\/[^/]+$/.test(assetUrl)) throw new Error("上传响应缺少 asset:// 素材地址");
      const type = refs[i].type === "image" ? "image_url" : "video_url";
      content.push({ type, [type]: { url: assetUrl }, role: roles[i] });
    }
    const request = {
      // Toonflow 的两个模型标识用于选择通道；Portal 仍使用原协议的 MiniMax-H3。
      model: "MiniMax-H3", content, resolution: config.resolution,
      duration: config.duration, ratio: config.aspectRatio, inference_steps: steps,
    };
    if (typeof queueH3Task === "function") {
      return await queueH3Task(JSON.stringify({ root, idempotencyKey, request }));
    }
    const response = await axios.post(`${root}/v2/video_generation`, request, { headers: { "Idempotency-Key": idempotencyKey }, timeout: 30000 });
    taskId = response.data?.task_id;
    if (typeof taskId !== "string" || !taskId) throw new Error("创建响应缺少 task_id");
    logger(`H3 ${channel} 任务已提交：${taskId}，可在 ${root} 查看`);
    let lastState = "";
    const result = await pollTask(async () => {
      let response;
      try {
        response = await axios.get(`${root}/v2/query/video_generation/${encodeURIComponent(taskId)}`, { timeout: 30000 });
      } catch (error: any) {
        const status = error?.response?.status;
        if (!status || status === 408 || status === 429 || status >= 500) {
          logger(`H3 ${taskId} 查询暂时中断，继续跟踪原任务：${describeError(error)}`);
          return { completed: false };
        }
        throw error;
      }
      const task = response.data?.task;
      if (!task) return { completed: false, error: "查询响应缺少 task" };
      if (task.status === "succeeded") {
        if (!task.content?.url) return { completed: false, error: "成功任务缺少 MP4 地址" };
        const path = task.content.url;
        // 当前 Portal 返回 /results/<token>，限定为同一 Portal 的结果路径。
        if (typeof path !== "string" || !/^\/results\/[^/?#]+$/.test(path)) return { completed: false, error: "Portal 返回了不支持的结果地址" };
        return { completed: true, data: `${root}${path}` };
      }
      if (task.status === "failed" || task.status === "cancelled") return { completed: false, error: task.error?.message || `任务 ${task.status}` };
      if (!["queued", "running"].includes(task.status)) return { completed: false, error: `未知任务状态：${task.status}` };
      const state = `${task.status}；排队位置=${task.queue_position ?? "-"}；${task.waiting_reason?.message || ""}`;
      if (state !== lastState) { logger(`H3 ${taskId}：${state}`); lastState = state; }
      return { completed: false };
    }, 5000, minutes * 60000);
    if (result.error || !result.completed || !result.data) throw new Error(result.error || "等待任务完成超时");
    return await urlToBase64(result.data);
  } catch (error) {
    const trace = taskId ? `task_id=${taskId}` : `Idempotency-Key=${idempotencyKey}`;
    throw new Error(`H3 调用失败：${describeError(error)}。${trace}；请在 ${root} 核对任务状态后再决定是否重试。`);
  }
};

const unsupported = () => { throw new Error("此供应商仅提供 Merlin MiniMax H3 视频模型"); };
exports.supportsH3TaskQueue = true;
exports.vendor = vendor;
exports.videoRequest = videoRequest;
exports.textRequest = unsupported;
exports.imageRequest = unsupported;
exports.ttsRequest = unsupported;
export {};
