import u from "@/utils";
import { getVendorTemplateFn } from "@/utils/ai";
import { queueH3VideoJob } from "./h3VideoJobs";
import { COMFY_DRAMA_MODEL, queueComfyVideo, type DramaSelection } from "./comfyShortDrama";

export async function generateWorkbenchVideo(
  model: `${string}:${string}`,
  input: Parameters<ReturnType<typeof u.Ai.Video>["run"]>[0],
  data: { videoId: number; videoPath: string; projectId: number; scriptId: number; uploadData?: DramaSelection[] },
) {
  const { videoId, videoPath, projectId, scriptId } = data;
  const related = { projectId, videoId, scriptId, type: "视频" };
  const isH3 = /^merlinminimaxh3(?:fl2va|ref2va):MiniMax-H3-(?:FL2VA|Ref2VA)$/.test(model);
  let taskId: number | undefined;
  let queued = false;
  try {
    if (model === COMFY_DRAMA_MODEL) {
      await queueComfyVideo(input, data);
      return;
    }
    if (isH3) {
      [taskId] = await u.db("o_tasks").insert({
        projectId, taskClass: "视频生成", model: model.split(":")[1], describe: "根据提示词生成视频",
        relatedObjects: JSON.stringify({ ...related, h3Preparation: true }), state: "进行中", startTime: Date.now(),
      });
      const fn = await getVendorTemplateFn("videoRequest", model, {
        queueH3Task: async request => {
          const result = await queueH3VideoJob(taskId!, request);
          queued = true;
          return result;
        },
      });
      await fn(input);
      if (!queued) throw new Error("请更新 H3 供应商代码以启用持久任务同步");
      return;
    }
    const ai = u.Ai.Video(model);
    await ai.run(input, { projectId, taskClass: "视频生成", describe: "根据提示词生成视频", relatedObjects: JSON.stringify(related) });
    await ai.save(videoPath);
    await u.db("o_video").where("id", videoId).update({ state: "生成成功" });
  } catch (error) {
    if (queued) return; // A persisted remote job is now owned by the reconciler.
    const reason = u.error(error).message;
    await u.db("o_video").where("id", videoId).update({ state: "生成失败", errorReason: reason });
    if (taskId) await u.db("o_tasks").where("id", taskId).update({ state: "生成失败", reason });
  }
}
