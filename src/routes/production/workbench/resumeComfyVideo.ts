import express from "express";
import crypto from "node:crypto";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/middleware/middleware";
import { success, error } from "@/lib/responseFormat";
import { reconcileComfyVideoJobs } from "@/lib/comfyShortDrama";

const router = express.Router();
export default router.post("/", validateFields({
  projectId: z.number().int().positive(), scriptId: z.number().int().nonnegative(), videoId: z.number().int().positive(),
}), async (req, res) => {
  const { projectId, scriptId, videoId } = req.body;
  const video = await u.db("o_video").where({ id: videoId, projectId, scriptId }).first();
  if (video?.state !== "生成失败") return res.status(400).send(error("只能恢复失败的分镜任务"));
  const tasks = await u.db("o_tasks").where({ projectId, model: "MiniMax-H3-ShortDrama", state: "生成失败" });
  const task = tasks.find(row => JSON.parse(row.relatedObjects || "{}").videoId === videoId);
  const related = JSON.parse(task?.relatedObjects || "{}");
  if (!task || !related.comfy?.prompt) return res.status(400).send(error("此任务没有可恢复的 ComfyUI 输入快照"));
  related.comfy.done = false;
  related.comfy.failures = 0;
  related.comfy.nextCheckAt = 0;
  related.comfy.promptId = crypto.randomUUID();
  await u.db.transaction(async trx => {
    await trx("o_tasks").where("id", task.id).update({ state: "进行中", reason: null, relatedObjects: JSON.stringify(related) });
    await trx("o_video").where("id", videoId).update({ state: "生成中", errorReason: null });
  });
  void reconcileComfyVideoJobs();
  res.send(success(videoId));
});
