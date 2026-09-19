import axios from "axios";
import db, { db as knexDb } from "@/utils/db";
import oss from "@/utils/oss";

// The existing task record owns the remote identity. No browser or in-memory
// generation promise is required to finish a submitted video after a restart.
interface H3Job {
  root: string;
  idempotencyKey?: string;
  request?: Record<string, unknown>;
  taskId?: string;
  firstSubmitAt?: number;
  nextCheckAt?: number;
  failures?: number;
  done?: boolean;
}

const active = new Map<number, Promise<void>>();
let timer: ReturnType<typeof setInterval> | undefined;
let scanPromise: Promise<void> | undefined;

function parseRelated(value: string | null | undefined): any {
  try { return JSON.parse(value || "{}"); } catch { return {}; }
}

function validRoot(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\/[^\s/?#]+$/.test(value);
}

export async function queueH3VideoJob(taskId: number, requestJson: string): Promise<string> {
  const prepared = JSON.parse(requestJson);
  if (!validRoot(prepared.root) || typeof prepared.idempotencyKey !== "string" || !prepared.request) {
    throw new Error("H3 持久任务参数无效");
  }
  const row = await db("o_tasks").where("id", taskId).first();
  if (!row) throw new Error("H3 本地任务不存在");
  const related = parseRelated(row.relatedObjects);
  delete related.h3Preparation;
  related.h3 = { root: prepared.root, idempotencyKey: prepared.idempotencyKey, request: prepared.request } satisfies H3Job;
  // Persist BEFORE the first POST. An ambiguous response is retried using the
  // same body/key, so the service returns the existing task instead of a new one.
  await db("o_tasks").where("id", taskId).update({ relatedObjects: JSON.stringify(related), state: "进行中", reason: null });
  void reconcileH3VideoJobs();
  return "";
}

async function syncOne(taskId: number): Promise<void> {
  const row = await db("o_tasks").where("id", taskId).first();
  if (!row) return;
  const related = parseRelated(row.relatedObjects);
  const job: H3Job | undefined = related.h3;
  if (!job || job.done || !validRoot(job.root) || (job.nextCheckAt || 0) > Date.now()) return;
  if (!Number.isInteger(related.videoId)) return;
  const video = await db("o_video").where({ id: related.videoId, projectId: row.projectId }).first();
  if (!video?.filePath) return;
  const persist = async (reason: string | null = null) => {
    await db("o_tasks").where("id", taskId).update({ relatedObjects: JSON.stringify(related), state: "进行中", reason });
  };
  const finish = async (success: boolean, reason: string | null) => {
    const finishedJob = { ...job, done: true };
    delete finishedJob.request;
    await knexDb.transaction(async trx => {
      await trx("o_video").where("id", video.id).update({ state: success ? "生成成功" : "生成失败", errorReason: reason });
      await trx("o_tasks").where("id", taskId).update({
        state: success ? "已完成" : "生成失败", reason, relatedObjects: JSON.stringify({ ...related, h3: finishedJob }),
      });
    });
  };
  try {
    if (!job.taskId) {
      if (!job.request || !job.idempotencyKey) throw new Error("H3 尚未关联任务，需核对提交状态");
      // Portal retains idempotency keys for 24 hours. Never replay an ambiguous
      // submission after that window, when it could start a second inference.
      if (job.firstSubmitAt && Date.now() - job.firstSubmitAt > 23 * 3600000) {
        throw new Error("提交状态待核对，已超过安全重试时间，未重新提交");
      }
      job.firstSubmitAt ||= Date.now();
      await persist();
      const response = await axios.post(`${job.root}/v2/video_generation`, job.request, {
        headers: { "Idempotency-Key": job.idempotencyKey }, timeout: 30000, maxRedirects: 0,
        validateStatus: () => true,
      });
      if ([400, 413, 415, 422].includes(response.status)) {
        await finish(false, `H3 拒绝提交：HTTP ${response.status}，${JSON.stringify(response.data?.detail || "参数无效")}`);
        return;
      }
      if (response.status < 200 || response.status >= 300) throw new Error(`提交状态待确认：HTTP ${response.status}`);
      const remoteId = response.data?.task_id;
      if (typeof remoteId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(remoteId)) throw new Error("提交响应缺少有效任务编号，使用原幂等键核对");
      job.taskId = remoteId;
      delete job.request;
      await persist();
    }
    const response = await axios.get(`${job.root}/v2/query/video_generation/${encodeURIComponent(job.taskId)}`, {
      timeout: 15000, maxRedirects: 0,
    });
    const remote = response.data?.task;
    if (!remote) throw new Error("查询响应缺少任务状态");
    if (remote.status === "failed" || remote.status === "cancelled") {
      await finish(false, `H3 ${job.taskId}：${remote.error?.message || remote.status}`);
      return;
    }
    if (remote.status === "succeeded") {
      const resultPath = remote.content?.url;
      if (typeof resultPath !== "string" || !/^\/results\/[^/?#]+$/.test(resultPath)) throw new Error("H3 结果地址无效，等待重新同步");
      const result = await axios.get(`${job.root}${resultPath}`, { responseType: "arraybuffer", timeout: 120000, maxRedirects: 0 });
      const bytes = Buffer.from(result.data);
      if (bytes.length < 12 || bytes.toString("ascii", 4, 8) !== "ftyp") throw new Error("H3 结果尚未获得有效 MP4，等待重新下载");
      await oss.writeFile(video.filePath, bytes);
      // A failed download/write must never mark a local video complete.
      await finish(true, null);
      return;
    }
    if (!["queued", "running"].includes(remote.status)) throw new Error(`H3 状态待核对：${remote.status}`);
    job.failures = 0;
    job.nextCheckAt = Date.now() + 10000;
    await db("o_video").where("id", video.id).update({ state: "生成中", errorReason: null });
    await persist(remote.status === "queued" ? `H3 排队中${remote.queue_position ? `，位置 ${remote.queue_position}` : ""}` : null);
  } catch (error: any) {
    job.failures = (job.failures || 0) + 1;
    job.nextCheckAt = Date.now() + Math.min(60000, 5000 * 2 ** Math.min(job.failures - 1, 4));
    // Do not expose raw Axios errors (they can retain upload contents).
    const detail = error?.response?.status ? `HTTP ${error.response.status}` : error?.code || error?.message || "连接中断";
    await db("o_video").where("id", video.id).update({ state: "生成中", errorReason: null });
    await persist(`H3 状态同步暂时中断，将自动重试：${detail}`);
  }
}

async function scanJobs(): Promise<void> {
  try {
    const rows = await db("o_tasks").where({ taskClass: "视频生成", state: "进行中" }).select("id", "relatedObjects");
    let index = 0;
    // Bound HTTP concurrency even if hundreds of videos are queued remotely.
    await Promise.all(Array.from({ length: Math.min(4, rows.length) }, async () => {
      while (index < rows.length) {
        const row = rows[index++];
        if (row.id === undefined) continue;
        if (!parseRelated(row.relatedObjects).h3 || active.has(row.id)) continue;
        const pending = syncOne(row.id);
        active.set(row.id, pending);
        try { await pending; } finally { active.delete(row.id); }
      }
    }));
  } catch (error: any) {
    console.error("[H3 状态同步]", error?.message || "同步异常");
  }
}

export function reconcileH3VideoJobs(): Promise<void> {
  if (!scanPromise) scanPromise = scanJobs().finally(() => { scanPromise = undefined; });
  return scanPromise;
}

export function startH3VideoSync() {
  if (timer) return;
  timer = setInterval(() => { void reconcileH3VideoJobs(); }, 5000);
  timer.unref();
  void reconcileH3VideoJobs();
}

export function stopH3VideoSync() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
