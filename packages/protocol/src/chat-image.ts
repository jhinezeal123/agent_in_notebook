/** Raster formats shared by the bridge and the two chat panels. */
export type ChatImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export const MAX_CHAT_IMAGE_BASE64 = 4 * 1024 * 1024;

export function isChatImageMime(mime: string): mime is ChatImageMime {
  return /^image\/(?:png|jpeg|gif|webp)$/.test(mime);
}

export function chatImageDataUrl(mime: string, data: string): string | undefined {
  if (!isChatImageMime(mime) || !data || data.length > MAX_CHAT_IMAGE_BASE64) return;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return;
  return `data:${mime};base64,${data}`;
}
