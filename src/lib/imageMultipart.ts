import axios from "axios";
import FormData from "form-data";
import { setImmediate } from "node:timers/promises";

interface ImageMultipartRequest {
  url: string;
  images: string[];
  fields: Record<string, string | number>;
  params: Record<string, string>;
  headers: Record<string, string>;
  timeout: number;
}

/**
 * Only JSON strings cross the vendor VM boundary. Passing Buffers, FormData,
 * Axios responses or Axios errors through VM2 scans every image byte and can
 * block all server requests for seconds. Keep those objects in the host.
 */
export async function postImageMultipart(requestJson: string): Promise<string> {
  await setImmediate();
  const request: ImageMultipartRequest = JSON.parse(requestJson);
  const body = new FormData();
  for (const [index, image] of request.images.entries()) {
    const comma = image.indexOf(",");
    const match = /^data:(image\/(?:png|jpe?g|webp));base64$/.exec(image.slice(0, comma));
    if (!match) throw new Error(`第 ${index + 1} 张参考图格式无效`);
    const mime = match[1].replace("image/jpg", "image/jpeg");
    body.append("image[]", Buffer.from(image.slice(comma + 1), "base64"), {
      filename: `reference-${index + 1}.${mime.split("/")[1]}`,
      contentType: mime,
    });
    // Give refreshes and polling requests a turn between large reference images.
    await setImmediate();
  }
  for (const [key, value] of Object.entries(request.fields)) body.append(key, String(value));
  try {
    const response = await axios.post(request.url, body, {
      params: request.params,
      headers: { ...body.getHeaders(), ...request.headers },
      timeout: request.timeout,
      maxBodyLength: Infinity,
      maxRedirects: 0,
      responseType: "json",
      validateStatus: () => true,
    });
    return JSON.stringify({ status: response.status, data: response.data });
  } catch (error: any) {
    // Never send a raw Axios error (including credentials and upload buffers)
    // back into the VM. The provider supplies the user-facing error and log ID.
    const code = ["ECONNABORTED", "ETIMEDOUT"].includes(error?.code) ? error.code : "ERR_IMAGE_UPLOAD";
    throw Object.assign(new Error("图片上传请求失败"), { code });
  }
}
