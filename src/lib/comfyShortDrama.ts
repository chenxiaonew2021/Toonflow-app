import axios from "axios";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import FormData from "form-data";
import { z } from "zod";
import db, { db as knexDb } from "@/utils/db";
import getPath from "@/utils/getPath";
import oss from "@/utils/oss";

export const COMFY_DRAMA_MODEL = "comfyshortdrama:MiniMax-H3-ShortDrama";
export const dramaSettingsSchema = z.object({
  bibleVersion: z.string().min(1).max(100).default("v1"),
  style: z.string().max(3000).default(""),
  negativePrompt: z.string().max(3000).default("不改变角色脸型、发型、服装和道具，不增加无关人物、字幕或水印。"),
  camera: z.object({ shot_size: z.string(), angle: z.string(), movement: z.string(), lens: z.string() }).strict()
    .default({ shot_size: "", angle: "", movement: "", lens: "" }),
  blocking: z.string().max(2000).default(""),
  stateIn: z.string().max(2000).default(""),
  stateOut: z.string().max(2000).default(""),
  axis: z.string().max(1000).default(""),
  screenDirection: z.string().max(1000).default(""),
  lighting: z.string().max(1000).default(""),
  timeOfDay: z.string().max(1000).default(""),
  sound: z.string().max(2000).default(""),
  previousVideoId: z.number().int().positive().nullable().default(null),
  entityOverrides: z.array(z.object({
    id: z.string(), version: z.string().optional(), description: z.string().optional(),
    wardrobe: z.string().optional(), voice: z.string().optional(),
  }).strict()).default([]),
  dialogue: z.array(z.object({
    speaker_id: z.string(), text: z.string(), delivery: z.string().default(""),
    kind: z.enum(["dialogue", "voiceover", "inner_voice"]).default("dialogue"),
  }).strict()).default([]),
}).strict();

export type DramaSettings = z.infer<typeof dramaSettingsSchema>;
export type DramaSelection = { id: number; sources: string };
export type DramaTarget = { videoId: number; videoPath: string; projectId: number; scriptId: number; uploadData?: DramaSelection[] };
type DramaInput = { prompt: string; duration: number; aspectRatio: string; resolution: string; audio?: boolean };

export async function dramaSettings(projectId: number, scriptId: number, trackId: number, settings?: unknown): Promise<DramaSettings> {
  const track = await db("o_videoTrack").where({ id: trackId, projectId, scriptId }).first();
  if (!track) throw new Error("分镜轨道不属于当前项目/剧集");
  const file = getPath(["shortDrama", String(projectId), String(scriptId), `${trackId}.json`]);
  if (settings !== undefined) {
    const parsed = dramaSettingsSchema.parse(settings);
    if (parsed.previousVideoId && (!parsed.stateIn.trim() || !parsed.stateOut.trim())) {
      throw new Error("接续镜头必须填写开场与收尾状态");
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(parsed, null, 2));
    await fs.rename(temporary, file);
    return parsed;
  }
  try { return dramaSettingsSchema.parse(JSON.parse(await fs.readFile(file, "utf8"))); }
  catch (error: any) { if (error.code !== "ENOENT") throw error; return dramaSettingsSchema.parse({}); }
}

function hash(value: Buffer | string) { return crypto.createHash("sha256").update(value).digest("hex"); }

function localRoot(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("ComfyUI 地址必须是本机 HTTP 根地址，如 http://127.0.0.1:8188");
  }
  return url.origin;
}

async function upload(root: string, bytes: Buffer, source: string) {
  const extension = path.extname(source).toLowerCase();
  const mime: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".mp4": "video/mp4", ".wav": "audio/wav", ".mp3": "audio/mpeg" };
  if (!mime[extension]) throw new Error(`不支持的参考素材格式 ${extension}`);
  const sha256 = hash(bytes);
  const form = new FormData();
  form.append("image", bytes, { filename: `${sha256}${extension}`, contentType: mime[extension] });
  form.append("type", "input");
  form.append("subfolder", "short-drama/references");
  const { data } = await axios.post(`${root}/upload/image`, form, {
    headers: form.getHeaders(), timeout: 120000, maxBodyLength: Infinity, maxRedirects: 0,
  });
  if (typeof data.name !== "string" || data.subfolder !== "short-drama/references" || data.type !== "input") {
    throw new Error("ComfyUI 素材上传响应无效");
  }
  return { file: `${data.subfolder}/${data.name}`, storage: "input", sha256, type: mime[extension].split("/")[0] };
}

export async function queueComfyVideo(input: DramaInput, target: DramaTarget) {
  const { videoId, projectId, scriptId } = target;
  const video = await db("o_video").where({ id: videoId, projectId, scriptId }).first();
  if (!video?.videoTrackId) throw new Error("视频没有对应分镜轨道");
  const [taskId] = await db("o_tasks").insert({
    projectId, taskClass: "视频生成", model: "MiniMax-H3-ShortDrama", describe: "ComfyUI 短剧分镜生成",
    state: "进行中", startTime: Date.now(), relatedObjects: JSON.stringify({ videoId, scriptId, type: "视频", comfyPreparation: true }),
  });
  try {
    const config = await db("o_vendorConfig").where({ id: "comfyshortdrama" }).first();
    if (!config || !config.enable) throw new Error("请启用 ComfyUI 短剧分镜供应商");
    const values = JSON.parse(config.inputValues || "{}");
    const root = localRoot(values.baseUrl || "http://127.0.0.1:8188");
    const settings = await dramaSettings(projectId, scriptId, video.videoTrackId);
    const project = await db("o_project").where("id", projectId).first();
    if (!project) throw new Error("项目不存在");
    if (input.audio === false) throw new Error("H3 生成原生音画；此工作流不支持关闭音频");
    const selection = target.uploadData || [];
    if (!selection.length || selection.length > 12) throw new Error("请选择 1–12 个参考素材，至少包含一张图片或一段视频");
    const references: any[] = [];
    const entities: any[] = [];
    const entityAssets = new Map<string, any>();
    const selectedIds = new Set<string>();
    for (const selected of selection) {
      const refId = `${selected.sources}_${selected.id}`;
      if (selectedIds.has(refId)) throw new Error("请勿重复选择同一素材");
      selectedIds.add(refId);
      let source: string | null | undefined;
      let asset: any;
      if (selected.sources === "assets") {
        asset = await db("o_assets").where({ "o_assets.id": selected.id, "o_assets.projectId": projectId })
          .leftJoin("o_image", "o_assets.imageId", "o_image.id")
          .select("o_assets.*", "o_image.filePath").first();
        source = asset?.filePath;
      } else if (selected.sources === "storyboard") {
        const board = await db("o_storyboard").where({ id: selected.id, projectId, scriptId }).first();
        source = board?.filePath;
      } else throw new Error("参考素材来源无效");
      if (!source) throw new Error(`素材 ${refId} 不存在、没有文件或不属于当前项目`);
      const uploaded = await upload(root, await oss.getFile(source), source);
      const kind = ({ role: "character", "角色": "character", scene: "scene", "场景": "scene", tool: "prop", "道具": "prop", audio: "voice" } as Record<string, string>)[asset?.type];
      const purpose = uploaded.type === "audio" ? "voice" : uploaded.type === "video" ? "motion"
        : kind === "character" ? "identity" : kind === "scene" ? "scene" : kind === "prop" ? "prop" : "composition";
      references.push({ id: refId, ...uploaded, purpose, description: asset?.name || `分镜图 ${selected.id}` });
      if (kind) {
        const entityId = `assets_${asset.assetsId || asset.id}`;
        if (entityAssets.has(entityId)) throw new Error("同一个实体请只选择一个造型/声音版本，避免相互冲突");
        entityAssets.set(entityId, asset);
        // The library asset owns identity; a derived look and its bytes own the version.
        entities.push({ id: entityId, kind, name: asset.name || entityId,
          version: hash(JSON.stringify([asset.describe, asset.prompt, uploaded.sha256])).slice(0, 16),
          description: [asset.describe, asset.prompt].filter(Boolean).join("；"), reference_ids: [refId] });
      }
    }
    for (const entity of entities.filter(item => item.kind === "character")) {
      const asset = entityAssets.get(entity.id);
      const bindings = await db("o_assetsRole2Audio").whereIn("assetsRoleId", [asset.id, asset.assetsId].filter(Boolean));
      const voices = entities.filter(item => item.kind === "voice" && bindings.some(binding => `assets_${binding.assetsAudioId}` === item.id));
      if (voices.length > 1) throw new Error(`角色 ${entity.name} 选中了多个绑定音色，请保留一个`);
      if (voices.length === 1) {
        entity.reference_ids.push(...voices[0].reference_ids);
        entity.voice = voices[0].description;
        entity.version = hash(JSON.stringify([entity.version, voices[0].version])).slice(0, 16);
      }
    }
    for (const override of settings.entityOverrides) {
      const entity = entities.find(item => item.id === override.id);
      if (!entity) throw new Error(`实体覆盖 ${override.id} 未在本镜头选中`);
      Object.assign(entity, override);
    }
    let previousShotId: string | null = null;
    if (settings.previousVideoId) {
      const previous = await db("o_video").where({ id: settings.previousVideoId, projectId, scriptId }).first();
      if (!previous?.filePath || !["生成成功", "已完成"].includes(previous.state || "") || previous.id === videoId || previous.videoTrackId === video.videoTrackId) {
        throw new Error("上一镜必须选择同剧集另一轨道中已审阅的成功视频");
      }
      const previousTrack = await db("o_videoTrack").where({ id: previous.videoTrackId!, projectId, scriptId }).first();
      if (previousTrack?.videoId !== previous.id) throw new Error("请先在上一镜视频列表中选定审阅通过的版本，再作为接续参考");
      const previousResult = JSON.parse((await oss.getFile(previous.filePath.replace(/\.mp4$/, ".json"))).toString("utf8"));
      if (!previousResult.toonflow?.lastFramePath) throw new Error("上一镜没有连续性末帧；请先用 ComfyUI 短剧工作流生成上一镜");
      const bytes = await oss.getFile(previousResult.toonflow.lastFramePath);
      if (hash(bytes) !== previousResult.last_frame.sha256) throw new Error("上一镜末帧已变化，请重新确认素材");
      const uploaded = await upload(root, bytes, previousResult.toonflow.lastFramePath);
      references.push({ id: "previous_last_frame", ...uploaded, purpose: "continuity", description: "已审阅的上一镜末帧" });
      previousShotId = previousResult.shot_id;
    }
    const requestId = `toonflow-${projectId}-${videoId}`;
    const request = {
      schema_version: "1.0", request_id: requestId, project_id: String(projectId), episode_id: String(scriptId),
      shot_id: String(video.videoTrackId), take: videoId,
      bible: { version: settings.bibleVersion, style: settings.style || project.artStyle || "遵循所选参考图的视觉风格",
        director_notes: project.directorManual || "", negative_prompt: settings.negativePrompt, entities },
      shot: { description: input.prompt, entity_ids: entities.map(item => item.id), camera: settings.camera,
        blocking: settings.blocking, dialogue: settings.dialogue, sound: settings.sound },
      continuity: { mode: previousShotId ? "match_previous" : "independent", previous_shot_id: previousShotId,
        previous_last_frame_id: previousShotId ? "previous_last_frame" : null, state_in: settings.stateIn,
        state_out: settings.stateOut, axis: settings.axis, screen_direction: settings.screenDirection,
        lighting: settings.lighting, time_of_day: settings.timeOfDay },
      references,
      generation: { model: "MiniMax-H3", workflow_version: "short-drama-v1", duration: input.duration,
        ratio: input.aspectRatio, resolution: input.resolution, inference_steps: Number(values.inferenceSteps || 5) },
    };
    // Preparation validates all material/contract limits without starting inference.
    const { data: prepared } = await axios.post(`${root}/short-drama/prepare`, request, { timeout: 120000, maxRedirects: 0 });
    const job: ComfyJob = { root, requestId, promptId: crypto.randomUUID(), prompt: prepared.prompt, inputHash: prepared.input_hash, failures: 0 };
    await db("o_tasks").where("id", taskId).update({ relatedObjects: JSON.stringify({ videoId, scriptId, type: "视频", comfy: job }) });
    void reconcileComfyVideoJobs();
  } catch (error: any) {
    const reason = error.response?.data?.error || error.code || error.message || "ComfyUI 分镜准备失败";
    await db("o_tasks").where("id", taskId).update({ state: "生成失败", reason: String(reason).slice(0, 2000) });
    throw new Error(String(reason).slice(0, 2000));
  }
}

interface ComfyJob {
  root: string;
  requestId: string;
  promptId: string;
  prompt?: Record<string, unknown>;
  inputHash: string;
  failures: number;
  nextCheckAt?: number;
  done?: boolean;
}

let timer: ReturnType<typeof setInterval> | undefined;
let scan: Promise<void> | undefined;

async function download(root: string, file: any): Promise<Buffer> {
  if (file?.type !== "output" || typeof file.filename !== "string" || typeof file.subfolder !== "string") throw new Error("ComfyUI 结果文件描述无效");
  const response = await axios.get(`${root}/view`, { params: { filename: file.filename, subfolder: file.subfolder, type: "output" },
    responseType: "arraybuffer", timeout: 120000, maxRedirects: 0 });
  const bytes = Buffer.from(response.data);
  if (hash(bytes) !== file.sha256) throw new Error("结果文件校验不匹配，等待重新下载");
  return bytes;
}

async function syncOne(row: any) {
  const related = JSON.parse(row.relatedObjects || "{}");
  const job: ComfyJob | undefined = related.comfy;
  if (!job || job.done || (job.nextCheckAt || 0) > Date.now()) return;
  const video = await db("o_video").where({ id: related.videoId, projectId: row.projectId, scriptId: related.scriptId }).first();
  if (!video?.filePath) return;
  const persist = async (reason: string | null) => {
    await db("o_tasks").where("id", row.id).update({ reason, relatedObjects: JSON.stringify(related) });
  };
  const finish = async (success: boolean, reason: string | null) => {
    const finishedJob = { ...job, done: true };
    if (success) delete finishedJob.prompt;
    await knexDb.transaction(async trx => {
      await trx("o_video").where("id", video.id).update({ state: success ? "生成成功" : "生成失败", errorReason: reason });
      await trx("o_tasks").where("id", row.id).update({ state: success ? "已完成" : "生成失败", reason, relatedObjects: JSON.stringify({ ...related, comfy: finishedJob }) });
    });
  };
  try {
    const root = localRoot(job.root);
    const state = await axios.get(`${root}/short-drama/jobs/${job.requestId}`, { timeout: 15000, maxRedirects: 0, validateStatus: code => code === 200 || code === 404 });
    if (state.data.input_hash && state.data.input_hash !== job.inputHash) {
      await finish(false, "ComfyUI 请求编号与输入快照不匹配，已停止同步"); return;
    }
    if (state.data.result) {
      const result = state.data.result;
      if (result.request_id !== job.requestId || result.project_id !== String(video.projectId) || result.shot_id !== String(video.videoTrackId)) {
        await finish(false, "ComfyUI 返回了其他分镜的结果"); return;
      }
      const bytes = await download(root, result.video);
      if (bytes.length < 12 || bytes.toString("ascii", 4, 8) !== "ftyp") throw new Error("生成结果不是有效 MP4");
      const firstPath = video.filePath.replace(/\.mp4$/, "-first.png");
      const lastPath = video.filePath.replace(/\.mp4$/, "-last.png");
      await oss.writeFile(video.filePath, bytes);
      await oss.writeFile(firstPath, await download(root, result.first_frame));
      await oss.writeFile(lastPath, await download(root, result.last_frame));
      const manifest = { ...result, toonflow: { videoId: video.id, videoPath: video.filePath, firstFramePath: firstPath, lastFramePath: lastPath,
        comfyPromptId: job.promptId, videoUrl: await oss.getFileUrl(video.filePath) } };
      await oss.writeFile(video.filePath.replace(/\.mp4$/, ".json"), Buffer.from(JSON.stringify(manifest, null, 2)));
      await finish(true, null); return;
    }
    const { data: history } = await axios.get(`${root}/history/${job.promptId}`, { timeout: 15000, maxRedirects: 0 });
    const execution = history[job.promptId];
    if (execution?.status?.status_str === "error") {
      const message = execution.status.messages?.find((item: any) => item[0] === "execution_error")?.[1]?.exception_message;
      await finish(false, `ComfyUI 任务 ${job.promptId}：${message || "执行失败或已取消"}。H3 任务可能仍在运行，请按原任务恢复。`); return;
    }
    if (execution?.status?.completed) {
      await finish(false, "ComfyUI 执行结束但缺少分镜结果清单，请检查工作流输出节点"); return;
    }
    const { data: queue } = await axios.get(`${root}/queue`, { timeout: 15000, maxRedirects: 0 });
    const queued = [...queue.queue_running, ...queue.queue_pending].some((item: any) => item[1] === job.promptId);
    if (!queued && !execution) {
      if (!job.prompt) throw new Error("缺少持久化工作流，无法恢复");
      // Persisted UUID plus immutable request_id allow recovery after a lost response/restart.
      // ComfyUI's queue is not idempotent; the H3 submission node owns inference deduplication.
      const response = await axios.post(`${root}/prompt`, { prompt_id: job.promptId, prompt: job.prompt },
        { timeout: 30000, maxRedirects: 0, validateStatus: () => true });
      if (response.status === 400) { await finish(false, `ComfyUI 拒绝工作流：${JSON.stringify(response.data).slice(0, 1500)}`); return; }
      if (response.status !== 200) throw new Error(`ComfyUI 提交状态待确认：HTTP ${response.status}`);
      if (response.data.prompt_id !== job.promptId) throw new Error("ComfyUI 未保留请求编号，请使用本项目版本");
    }
    job.failures = 0;
    job.nextCheckAt = Date.now() + 10000;
    await persist(state.data.task ? `H3 ${state.data.task.task_id}，等待 ComfyUI 输出` : "ComfyUI 排队中");
  } catch (error: any) {
    job.failures += 1;
    job.nextCheckAt = Date.now() + Math.min(60000, 5000 * 2 ** Math.min(job.failures, 4));
    await persist(`ComfyUI 结果同步将继续重试：${error.response?.status ? `HTTP ${error.response.status}` : error.code || error.message}`);
  }
}

export function reconcileComfyVideoJobs(): Promise<void> {
  if (!scan) scan = (async () => {
    const rows = await db("o_tasks").where({ taskClass: "视频生成", state: "进行中", model: "MiniMax-H3-ShortDrama" });
    // Bounded requests and a single scanner prevent concurrent submissions of the same local task.
    for (const row of rows) await syncOne(row);
  })().catch(error => { console.error("[ComfyUI 同步]", error.message); }).finally(() => { scan = undefined; });
  return scan;
}

export async function startComfyVideoSync() {
  if (timer) return;
  const rows = await db("o_tasks").where({ taskClass: "视频生成", state: "进行中", model: "MiniMax-H3-ShortDrama" });
  for (const row of rows) {
    const related = JSON.parse(row.relatedObjects || "{}");
    if (!related.comfyPreparation) continue;
    const reason = "服务在素材准备阶段重启，尚未提交推理，请重新生成";
    await db("o_tasks").where("id", row.id).update({ state: "生成失败", reason });
    await db("o_video").where("id", related.videoId).update({ state: "生成失败", errorReason: reason });
  }
  timer = setInterval(() => { void reconcileComfyVideoJobs(); }, 5000);
  timer.unref();
  void reconcileComfyVideoJobs();
}

export function stopComfyVideoSync() { if (timer) clearInterval(timer); timer = undefined; }
