import express from "express";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
import { success, error } from "@/lib/responseFormat";
import { dramaSettings, dramaSettingsSchema } from "@/lib/comfyShortDrama";
import u from "@/utils";

const router = express.Router();
export default router.post("/", validateFields({
  projectId: z.number().int().positive(), scriptId: z.number().int().nonnegative(), trackId: z.number().int().positive(),
  settings: dramaSettingsSchema.optional(),
}), async (req, res) => {
  try {
    const { projectId, scriptId, trackId, settings } = req.body;
    const saved = await dramaSettings(projectId, scriptId, trackId, settings);
    const videos = await u.db("o_video").where({ "o_video.projectId": projectId, "o_video.scriptId": scriptId })
      .whereNot("videoTrackId", trackId).whereIn("o_video.state", ["生成成功", "已完成"])
      .join("o_videoTrack", "o_video.videoTrackId", "o_videoTrack.id")
      .whereRaw("?? = ??", ["o_video.id", "o_videoTrack.videoId"]).select("o_video.*").orderBy("time", "desc");
    const previousVideos = [];
    for (const video of videos) {
      if (!video.filePath) continue;
      const manifestPath = video.filePath.replace(/\.mp4$/, ".json");
      if (!await u.oss.fileExists(manifestPath)) continue;
      const manifest = JSON.parse((await u.oss.getFile(manifestPath)).toString("utf8"));
      if (manifest.toonflow?.lastFramePath) previousVideos.push({ value: video.id, label: `轨道 ${video.videoTrackId} · 视频 ${video.id}`, src: await u.oss.getFileUrl(video.filePath) });
    }
    res.send(success({ settings: saved, previousVideos }));
  } catch (e: any) { res.status(400).send(error(e.message)); }
});
