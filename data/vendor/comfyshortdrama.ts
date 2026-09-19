declare const exports: Record<string, any>;

// Workbench generation is owned by the durable host-side ComfyUI job adapter.
const vendor = {
  id: "comfyshortdrama", version: "2.0", name: "ComfyUI · 短剧一致性分镜", author: "Local",
  description: "在 ComfyUI 中编排角色、场景、声音与镜头连续性，通过本地 H3 生成后回收视频和末帧。请在剧集视频工作台使用。",
  inputs: [
    { key: "baseUrl", label: "ComfyUI 地址", type: "url", required: true, placeholder: "http://127.0.0.1:8188" },
    { key: "inferenceSteps", label: "H3 推理步数", type: "text", required: true, placeholder: "5" },
  ],
  inputValues: { baseUrl: "http://127.0.0.1:8188", inferenceSteps: "5" },
  models: [{
    name: "H3 · 短剧一致性分镜", modelName: "MiniMax-H3-ShortDrama", type: "video", audio: true,
    mode: [["imageReference:9", "videoReference:3", "audioReference:3"]],
    durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["768P"] }],
  }],
};
const unsupported = () => { throw new Error("请在剧集视频工作台选择本模型；此工作流需要项目、分镜和素材关联，不支持设置页单独试跑。"); };
exports.vendor = vendor;
exports.videoRequest = unsupported;
exports.textRequest = unsupported;
exports.imageRequest = unsupported;
exports.ttsRequest = unsupported;
export {};
