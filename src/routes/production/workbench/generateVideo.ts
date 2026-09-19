import express from "express";
import u from "@/utils";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { ReferenceList } from "@/utils/ai";
import { generateWorkbenchVideo } from "@/lib/generateWorkbenchVideo";
import { COMFY_DRAMA_MODEL } from "@/lib/comfyShortDrama";
const router = express.Router();

type Type = "imageReference" | "startImage" | "endImage" | "videoReference" | "audioReference";
interface UploadItem {
  fileType: "image" | "video" | "audio";
  type: Type;
  role?: "first_frame" | "last_frame";
  sources?: "assets" | "storyboard";
  id?: number;
  src?: string;
  label?: string;
  prompt?: string;
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    uploadData: z.array(
      z.object({
        id: z.number(),
        sources: z.string(),
        role: z.enum(["first_frame", "last_frame"]).optional(),
      }),
    ),
    prompt: z.string(),
    model: z.string(),
    mode: z.string(),
    resolution: z.string(),
    duration: z.number(),
    audio: z.boolean().optional(),
    trackId: z.number(),
  }),
  async (req, res) => {
    const { scriptId, projectId, prompt, uploadData, model, duration, resolution, audio, mode, trackId } = req.body;
    let modeData = [];
    if (Array.isArray(mode)) {
    } else if (typeof mode === "string" && mode.startsWith('["') && mode.endsWith('"]')) {
      try {
        modeData = JSON.parse(mode);
      } catch (e) {}
    }
    //获取生成视频比例
    const ratio = await u.db("o_project").select("videoRatio").where("id", projectId).first();
    const videoPath = `/${projectId}/video/${uuidv4()}.mp4`; //视频保存路径
    //查询出图片数据
    const images = model === COMFY_DRAMA_MODEL ? [] : await Promise.all(
      uploadData.map(async (item: UploadItem) => {
        if (item.sources === "storyboard") {
          const filePath = await u.db("o_storyboard").where("id", item.id).select("filePath").first();
          return { path: filePath?.filePath, sources: "storyBoard", role: item.role };
        }
        if (item.sources === "assets") {
          const filePath = await u
            .db("o_assets")
            .where("o_assets.id", item.id)
            .leftJoin("o_image", "o_assets.imageId", "o_image.id")
            .select("o_image.filePath", "o_image.type")
            .first();
          return { path: filePath?.filePath, sources: filePath.type, role: item.role };
        }
      }),
    );
    //把images里面的图片转成base64格式
    const base64 = await Promise.all(
      images.map(async (item) => {
        if (!item) return null;
        return { base64: await u.oss.getImageBase64(item.path), type: item.sources == "audio" ? "audio" : item.sources == "video" ? "video" : "image", ...(item.role ? { role: item.role } : {}) };
      }),
    );
    //新增
    const [videoId] = await u.db("o_video").insert({
      filePath: videoPath,
      time: Date.now(),
      state: "生成中",
      scriptId,
      projectId,
      videoTrackId: trackId,
    });
    res.status(200).send(success(videoId));
    void generateWorkbenchVideo(model, {
      prompt,
      referenceList: base64.filter(Boolean) as ReferenceList[],
      mode: modeData.length > 0 ? modeData : mode,
      duration,
      aspectRatio: (ratio?.videoRatio as "16:9" | "9:16") || "16:9",
      resolution,
      audio,
    }, { videoId, videoPath, projectId, scriptId, uploadData });
  },
);
