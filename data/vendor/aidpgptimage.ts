/**
 * Toonflow AI供应商模板
 * @version 2.9
 */

// ============================================================
// 类型定义
// ============================================================

type VideoMode =
  | "singleImage" //单图参考
  | "startEndRequired" //首尾帧（两张都得有）
  | "endFrameOptional" //首尾帧（尾帧可选）
  | "startFrameOptional" //首尾帧（首帧可选）
  | "text" //文本
  | (`videoReference:${number}` | `imageReference:${number}` | `audioReference:${number}`)[]; //多参考（数字代表限制数量）

interface TextModel {
  name: string;
  modelName: string;
  type: "text";
  think: boolean;
}

interface ImageModel {
  name: string;
  modelName: string;
  type: "image";
  mode: ("text" | "singleImage" | "multiReference")[];
  associationSkills?: string;
}

interface VideoModel {
  name: string;
  modelName: string;
  type: "video";
  mode: VideoMode[];
  associationSkills?: string;
  audio: "optional" | false | true;
  durationResolutionMap: { duration: number[]; resolution: string[] }[];
}

interface TTSModel {
  name: string;
  modelName: string;
  type: "tts";
  voices: { title: string; voice: string }[];
}

interface VendorConfig {
  id: string; //唯一ID，作为文件名存储用户磁盘上，禁止符号
  version: string; //版本号，格式为x.y，需遵守语义化版本控制
  name: string; //供应商名称
  author: string; //作者
  description?: string; //描述，支持Markdown格式
  icon?: string; //图标，仅支持Base64格式，建议尺寸为128x128像素
  inputs: { key: string; label: string; type: "text" | "password" | "url"; required: boolean; placeholder?: string }[];
  inputValues: Record<string, string>;
  models: (TextModel | ImageModel | VideoModel | TTSModel)[];
}

type ReferenceList =
  | { type: "image"; sourceType: "base64"; base64: string }
  | { type: "audio"; sourceType: "base64"; base64: string }
  | { type: "video"; sourceType: "base64"; base64: string };

interface ImageConfig {
  prompt: string;
  referenceList?: Extract<ReferenceList, { type: "image" }>[];
  size: "1K" | "2K" | "4K";
  aspectRatio: `${number}:${number}`;
}

interface VideoConfig {
  duration: number;
  resolution: string;
  aspectRatio: "16:9" | "9:16";
  prompt: string;
  referenceList?: ReferenceList[];
  audio?: boolean;
  mode: VideoMode[];
}

interface TTSConfig {
  text: string;
  voice: string;
  speechRate: number;
  pitchRate: number;
  volume: number;
  referenceList?: Extract<ReferenceList, { type: "audio" }>[];
}

interface PollResult {
  completed: boolean;
  data?: string;
  error?: string;
}

// ============================================================
// 全局声明
// ============================================================

declare const axios: any; // HTTP请求库
declare const FormData: any; // Toonflow 注入的 form-data
declare const postImageMultipart: (requestJson: string) => Promise<string>; // 宿主上传原图，避免二进制对象跨沙盒
declare const logger: (msg: string) => void; // 日志函数
declare const jsonwebtoken: any; // JWT处理库
declare const zipImage: (base64: string, size: number) => Promise<string>; // 图片压缩函数，返回有头base64字符串
declare const zipImageResolution: (base64: string, w: number, h: number) => Promise<string>; // 图片分辨率调整函数，返回有头base64字符串
declare const mergeImages: (base64Arr: string[], maxSize?: string) => Promise<string>; // 图片合成函数，返回有头base64字符串
declare const urlToBase64: (url: string) => Promise<string>; // URL转Base64函数，返回有头base64字符串
declare const pollTask: (fn: () => Promise<PollResult>, interval?: number, timeout?: number) => Promise<PollResult>; // 轮询函数，fn为异步函数，interval为轮询间隔，timeout为超时时间，返回fn的结果
declare const createOpenAI: any;
declare const createDeepSeek: any;
declare const createZhipu: any;
declare const createQwen: any;
declare const createAnthropic: any;
declare const createOpenAICompatible: any;
declare const createXai: any;
declare const createMinimax: any;
declare const createGoogleGenerativeAI: any;
declare const exports: {
  vendor: VendorConfig;
  textRequest: (m: TextModel, t: boolean, tl: 0 | 1 | 2 | 3) => any; //文本模型
  imageRequest: (c: ImageConfig, m: ImageModel) => Promise<string>; //图片模型，返回有头base64字符串
  videoRequest: (c: VideoConfig, m: VideoModel) => Promise<string>; //视频模型，返回有头base64字符串
  ttsRequest: (c: TTSConfig, m: TTSModel) => Promise<string>; //（暂未开放）语音模型，返回有头base64字符串
  checkForUpdates?: () => Promise<{ hasUpdate: boolean; latestVersion: string; notice: string }>; //检查更新函数，返回是否有更新和最新版本号和更公告（支持Markdown格式）
  updateVendor?: () => Promise<string>; //更新函数，返回最新的代码文本
};

// ============================================================
// 供应商配置
// ============================================================

const vendor: VendorConfig = {
  id: "aidpgptimage",
  version: "2.9",
  author: "Local",
  name: "Custom",
  description: "支持 Gemini 3.1 Pro 及 GPT Image 2。图片输出固定 16:9，尺寸和质量跟随界面分辨率：1K＝1280×720／low，2K＝2048×1152／medium，4K＝3840×2160／high。单图及多图参考通过独立 GPT OpenAPI edits 的 multipart image[] 上传原图，文本及文生图使用 ModelHub 地址。",
  inputs: [
    { key: "apiKey", label: "AIDP AK", type: "password", required: true },
    { key: "baseUrl", label: "文本及文生图基础地址", type: "url", required: true, placeholder: "以 /api/modelhub/online/v2/crawl/openai/deployments/gpt_openapi 结束" },
    { key: "editBaseUrl", label: "参考图请求基础地址", type: "url", required: true, placeholder: "以 /gpt/openapi/online/v2/crawl/openai 结束" },
  ],
  inputValues: {
    apiKey: "",
    baseUrl: "https://aidp.bytedance.net/api/modelhub/online/v2/crawl/openai/deployments/gpt_openapi",
    editBaseUrl: "https://aidp.bytedance.net/gpt/openapi/online/v2/crawl/openai",
  },
  models: [
    { name: "GPT Image 2", modelName: "gpt-image-2", type: "image", mode: ["text", "singleImage", "multiReference"] },
    { name: "Gemini 3.1 Pro", modelName: "gemini-3.1-p", type: "text", think: true },
  ],
};

// ============================================================
// 适配器函数
// ============================================================

// 函数片段供阅读；完整供应商配置在 data/vendor/aidpgptimage.ts。
// 复用用户指定的 OpenAI 兼容基础地址，保留 SDK 的消息、工具和流式处理。
const textRequest = (model: TextModel, think: boolean, thinkLevel: 0 | 1 | 2 | 3) => {
  const apiKey = vendor.inputValues.apiKey?.trim();
  const baseUrl = vendor.inputValues.baseUrl?.trim().replace(/\/+$/, "");
  if (!apiKey) throw new Error("请填写 AIDP AK");
  if (!baseUrl) throw new Error("请填写请求基础地址");
  if (!/^https:\/\/[^/?#]+\/api\/modelhub\/online\/v2\/crawl\/openai(?:\/deployments\/[^/?#]+)?$/.test(baseUrl)) {
    throw new Error("请填写 AIDP OpenAI 基础地址或 deployments 部署地址，不要在地址中附带 AK");
  }
  if (!model.modelName?.trim()) throw new Error("请填写 AIDP 文本模型标识");
  // 沿用 AIDP 已验证的 budget_tokens 协议，三档为应用侧预算。
  // 通用 AI 等调用方只传 think=true、未指定档位（0）时，默认轻度。
  const level = model.think && think !== false ? thinkLevel || 1 : 0;
  const budgetByLevel = { 0: 0, 1: 1024, 2: 8192, 3: 24576 };
  const budget = budgetByLevel[level];
  const enableThinking = budget > 0;
  // 默认总上限包含思考预算，并额外预留 4096 token 给回答；显式任务上限仍优先。
  const maxTokens = budget + 4096;
  const logId = `toonflow-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  logger(`AIDP 文本模型 ${model.modelName}：thinking level=${level}，budget=${budget}，logID=${logId}`);
  const isGemini = model.modelName.startsWith("gemini-");
  // AIDP 的 signature 字段不在 SDK 的标准 OpenAI 响应结构中。
  // 缓存仅属于本次模型调用链，以 tool call ID 匹配；不记录或伪造签名。
  const signatures = new Map<string, { messageSignature?: any; toolSignature?: any }>();
  const createSignatureCollector = () => {
    let messageSignature: any;
    const calls = new Map<number, { id?: string; signature?: any }>();
    return {
      processChunk: (body: any) => {
        const choice = body?.choices?.[0];
        const message = choice?.message ?? choice?.delta;
        if (!message) return;
        if (message.signature != null) messageSignature = message.signature;
        for (const [i, part] of (message.tool_calls ?? []).entries()) {
          const index = part.index ?? i;
          const call = calls.get(index) ?? {};
          if (part.id != null) call.id = part.id;
          if (part.signature != null) call.signature = part.signature;
          calls.set(index, call);
        }
      },
      buildMetadata: () => {
        for (const call of calls.values()) {
          if (call.id != null) signatures.set(call.id, { messageSignature, toolSignature: call.signature });
        }
        return {};
      },
    };
  };
  const restoreSignatures = (message: any) => {
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) return message;
    const messageSignature = message.tool_calls.map((call: any) => signatures.get(call.id)?.messageSignature).find((value: any) => value != null);
    return {
      ...message,
      ...(messageSignature != null && message.signature == null ? { signature: messageSignature } : {}),
      tool_calls: message.tool_calls.map((call: any) => {
        const signature = signatures.get(call.id)?.toolSignature;
        return signature != null && call.signature == null ? { ...call, signature } : call;
      }),
    };
  };
  return createOpenAICompatible({
    name: "aidp",
    baseURL: baseUrl,
    // AK 放在请求头，避免 SDK 错误中的 URL 带出密钥。
    headers: { "api-key": apiKey, "X-TT-LOGID": logId },
    ...(isGemini
      ? {
          metadataExtractor: {
            extractMetadata: async ({ parsedBody }: { parsedBody: any }) => {
              const collector = createSignatureCollector();
              collector.processChunk(parsedBody);
              return collector.buildMetadata();
            },
            createStreamExtractor: createSignatureCollector,
          },
        }
      : {}),
    transformRequestBody: (args: Record<string, any>) => ({
      ...args,
      // Zod toJSONSchema 的文档版本声明不属于 Gemini FunctionDeclaration.parameters。
      // 仅处理 Gemini 工具参数根节点，保留业务字段、嵌套约束和其他模型的原始协议。
      ...(isGemini && Array.isArray(args.tools)
        ? {
            tools: args.tools.map((item: any) => {
              if (item.type !== "function" || !item.function?.parameters) return item;
              const { $schema, ...parameters } = item.function.parameters;
              return { ...item, function: { ...item.function, parameters } };
            }),
          }
        : {}),
      ...(isGemini && Array.isArray(args.messages) ? { messages: args.messages.map(restoreSignatures) } : {}),
      max_tokens: args.max_tokens ?? maxTokens,
      stream: args.stream ?? false,
      thinking: {
        include_thoughts: enableThinking,
        budget_tokens: enableThinking ? budget : 0,
      },
    }),
  }).chatModel(model.modelName);
};

// 函数片段供阅读；界面请复制 data/vendor/aidpgptimage.ts 完整文件，包含配套供应商字段。
// 无参考图使用 ModelHub generations JSON；有参考图使用已验证的 GPT OpenAPI edits multipart。
const imageRequest = async (config: ImageConfig, model: ImageModel): Promise<string> => {
  const apiKey = vendor.inputValues.apiKey?.trim();
  if (!apiKey) throw new Error("请填写 AIDP AK");
  if (!config.prompt?.trim()) throw new Error("请输入图片提示词");
  if (!model.modelName?.trim()) throw new Error("请填写 AIDP 模型标识");

  const references = config.referenceList ?? [];
  const operation = references.length ? "edits" : "generations";
  const baseUrl = (references.length ? vendor.inputValues.editBaseUrl : vendor.inputValues.baseUrl)?.trim().replace(/\/+$/, "");
  if (!baseUrl) throw new Error(references.length ? "请填写参考图请求基础地址" : "请填写请求基础地址");
  const root = baseUrl.replace(/\/images\/(generations|edits)$/, "");
  if (references.length && !/^https:\/\/[^/?#]+\/gpt\/openapi\/online\/v2\/crawl\/openai$/.test(root)) {
    throw new Error("参考图请求基础地址应以 /gpt/openapi/online/v2/crawl/openai 结束，也可填完整 images/edits 路径；不要在地址中附带 AK");
  }
  if (!references.length && !/^https:\/\/[^/?#]+\/api\/modelhub\/online\/v2\/crawl\/openai(?:\/deployments\/[^/?#]+)?$/.test(root)) {
    throw new Error("请填写 AIDP OpenAI 基础地址或 deployments 部署地址，也可填完整 images 路径；不要在地址中附带 AK");
  }
  const endpoint = `${root}/images/${operation}`;
  // 使用界面传入的分辨率，按用户要求所有档位固定 16:9。
  // 旧供应商 imageSize/imageQuality 及调用方 aspectRatio 不再覆盖上述设置。
  // GPT Image 2：边长为 16 的倍数，最大边 3840，总像素 655360～8294400。
  // 1024×576 低于最小像素数，因此 1K 宽屏使用 1280×720。
  const resolution = config.size?.trim() || "2K";
  const aspectRatio = "16:9";
  if (!["1K", "2K", "4K"].includes(resolution)) throw new Error("图片分辨率仅支持 1K、2K、4K");
  const presets: Record<string, { quality: string; size: string }> = {
    "1K": { quality: "low", size: "1280x720" },
    "2K": { quality: "medium", size: "2048x1152" },
    "4K": { quality: "high", size: "3840x2160" },
  };
  const { quality, size } = presets[resolution];
  const fields = { model: model.modelName, prompt: config.prompt, n: 1, size, quality };
  let images: string[] = [];
  if (references.length) {
    if (typeof postImageMultipart !== "function") throw new Error("请更新并重启 Toonflow 后端以启用参考图上传优化");
    images = references.map((reference, index) => {
      let imageUrl = reference.base64?.trim();
      if (!imageUrl) throw new Error(`第 ${index + 1} 张参考图为空`);
      if (!imageUrl.startsWith("data:")) {
        const mime = imageUrl.startsWith("iVBORw0KGgo") ? "image/png" : imageUrl.startsWith("/9j/") ? "image/jpeg" : imageUrl.startsWith("UklGR") ? "image/webp" : "";
        if (!mime) throw new Error(`第 ${index + 1} 张参考图缺少图片格式，请使用 PNG、JPEG 或 WebP data URL`);
        imageUrl = `data:${mime};base64,${imageUrl}`;
      }
      if (!/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=\s]+$/.test(imageUrl)) {
        throw new Error(`第 ${index + 1} 张参考图必须为 PNG、JPEG 或 WebP Base64 图片`);
      }
      return imageUrl;
    });
  }

  const logId = `toonflow-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  logger(`AIDP ${operation}：${resolution} ${aspectRatio} → ${size}，quality=${quality}，参考图 ${references.length} 张，logID=${logId}`);
  let response: any;
  try {
    response = references.length
      ? JSON.parse(await postImageMultipart(JSON.stringify({
        url: endpoint,
        images,
        fields,
        params: { ak: apiKey },
        headers: { "X-TT-LOGID": logId },
        timeout: 300000,
      })))
      : await axios.post(
      endpoint,
      fields,
      {
        params: { ak: apiKey },
        headers: { "Content-Type": "application/json", "X-TT-LOGID": logId },
        timeout: 300000,
        maxBodyLength: Infinity,
        maxRedirects: 0,
        validateStatus: () => true,
      },
    );
  } catch (err: any) {
    // 不直接抛出 Axios 错误对象，避免其请求配置携带 AK 进入应用日志。
    if (err?.code === "ECONNABORTED" || err?.code === "ETIMEDOUT") {
      throw new Error(`AIDP 图片请求超时；本次没有自动重试。logID=${logId}`);
    }
    throw new Error(`无法连接 AIDP 图片接口，请检查网络和请求地址。logID=${logId}`);
  }

  const data = response.data;
  if (response.status < 200 || response.status >= 300 || data?.error) {
    const detail = data?.error?.message || data?.message || (typeof data?.error === "string" ? data.error : "请求失败");
    const safeDetail = String(detail).split(apiKey).join("[已隐藏]").split(encodeURIComponent(apiKey)).join("[已隐藏]").slice(0, 500);
    throw new Error(`AIDP 图片请求失败（HTTP ${response.status}）：${safeDetail}。logID=${logId}`);
  }
  const item = data?.data?.[0];
  if (typeof item?.b64_json === "string" && item.b64_json.trim()) {
    const encoded = item.b64_json.trim();
    if (encoded.startsWith("data:image/")) return encoded;
    const format = data.output_format;
    const mime = format === "jpeg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png";
    return `data:${mime};base64,${encoded}`;
  }
  if (typeof item?.url === "string" && /^https?:\/\//.test(item.url)) {
    try {
      return await urlToBase64(item.url);
    } catch {
      throw new Error("AIDP 已返回图片地址，但下载图片失败");
    }
  }
  throw new Error("AIDP 响应缺少 data[0].b64_json 或图片 URL，请核对接口返回格式");
};

const videoRequest = async (config: VideoConfig, model: VideoModel): Promise<string> => {
  return "";
};

const ttsRequest = async (config: TTSConfig, model: TTSModel): Promise<string> => {
  return "";
};

const checkForUpdates = async (): Promise<{ hasUpdate: boolean; latestVersion: string; notice: string }> => {
  return { hasUpdate: false, latestVersion: "2.4", notice: "## 新版本更新公告" };
};

const updateVendor = async (): Promise<string> => {
  return "";
};

// ============================================================
// 导出
// ============================================================

exports.vendor = vendor;
exports.textRequest = textRequest;
exports.imageRequest = imageRequest;
exports.videoRequest = videoRequest;
exports.ttsRequest = ttsRequest;
exports.checkForUpdates = checkForUpdates;
exports.updateVendor = updateVendor;

// 这行代码用于确保当前文件被识别为模块，避免全局变量冲突
export {};
