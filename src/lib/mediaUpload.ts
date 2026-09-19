import axios from "axios";
import FormData from "form-data";
import { setImmediate } from "node:timers/promises";

/** Upload a reference file without exposing Buffers or Axios objects to VM2. */
export async function uploadMediaFile(dataUrl: string, requestJson: string): Promise<string> {
  await setImmediate();
  // Keep the large string separate: JSON serialization would copy every byte
  // synchronously for every task in a batch before the first asynchronous yield.
  const request: { url: string; filename: string; timeout: number } = JSON.parse(requestJson);
  const comma = dataUrl.indexOf(",");
  const match = /^data:(image\/(?:png|jpeg|webp)|video\/mp4);base64$/.exec(dataUrl.slice(0, comma));
  if (!match) throw new Error("参考素材格式不正确；图片支持 PNG/JPEG/WebP，视频支持 MP4");
  const body = new FormData();
  body.append("file", Buffer.from(dataUrl.slice(comma + 1), "base64"), {
    filename: request.filename,
    contentType: match[1],
  });
  try {
    const response = await axios.post(request.url, body, {
      headers: body.getHeaders(),
      timeout: request.timeout,
      maxBodyLength: Infinity,
      maxRedirects: 0,
      responseType: "json",
      validateStatus: () => true,
    });
    // Raw responses/errors retain the entire uploaded file inside config.data.
    return JSON.stringify({ status: response.status, data: response.data });
  } catch (error: any) {
    const code = typeof error?.code === "string" && /^[A-Z_]{1,40}$/.test(error.code) ? error.code : "ERR_MEDIA_UPLOAD";
    throw Object.assign(new Error("素材上传请求失败"), { code });
  }
}
