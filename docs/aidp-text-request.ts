// 函数片段供阅读；完整供应商配置在 ../data/vendor/aidpgptimage.ts。
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
