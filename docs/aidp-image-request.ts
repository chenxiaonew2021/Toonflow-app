// 函数片段供阅读；界面请复制 ../data/vendor/aidpgptimage.ts 完整文件，包含配套供应商字段。
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
