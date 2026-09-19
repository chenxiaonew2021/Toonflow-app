import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    videoIds: z.array(z.number()),
  }),
  async (req, res) => {
    const { projectId, scriptId, videoIds } = req.body;
    const videoList = await u
      .db("o_video")
      .where({ projectId, scriptId })
      .whereIn("id", videoIds)
      .select("id", "time", "state", "errorReason", "filePath");
    res.status(200).send(
      success(
        await Promise.all(
          videoList.map(async (s) => ({
            ...s,
            state: s.state === "生成成功" ? "已完成" : s.state,
            src: s.filePath && ["生成成功", "已完成"].includes(s.state ?? "") ? await u.oss.getFileUrl(s.filePath) : "",
            errorReason: ["生成成功", "已完成"].includes(s.state ?? "") ? "" : s.errorReason,
          })),
        ),
      ),
    );
  },
);
