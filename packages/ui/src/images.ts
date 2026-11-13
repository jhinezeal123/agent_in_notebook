import { chatImageDataUrl } from "@ainb/protocol";
import { chatFileLink, externalChatUrl } from "./chat-links.js";

/** Accept only HTTPS images or embedded raster data. */
export function chatImageSource(source: string): string | undefined {
  if (/^https:\/\//i.test(source)) return externalChatUrl(source);
  const data = /^data:(image\/[a-z]+);base64,(.+)$/i.exec(source);
  if (data) return chatImageDataUrl(data[1]!.toLowerCase(), data[2]!);
}

export function decorateMarkdownImages(fragment: DocumentFragment, localImages: boolean): void {
  for (const image of fragment.querySelectorAll("img")) {
    const source = image.dataset.imageSource ?? image.getAttribute("src") ?? "";
    const src = chatImageSource(source);
    const file = localImages ? chatFileLink(source) : undefined;
    const label = image.alt.trim() || "Image";
    const wrapper = document.createElement("span");
    wrapper.className = "chat-image";
    const preview = document.createElement("img");
    preview.alt = label;
    preview.title = image.title;
    preview.loading = "lazy";
    preview.decoding = "async";
    preview.referrerPolicy = "no-referrer";
    if (src) preview.setAttribute("src", src);
    else if (file && file.line === undefined) preview.dataset.localImage = source;
    else wrapper.classList.add("image-unavailable");
    const fallback = document.createElement("span");
    fallback.className = "image-fallback";
    fallback.textContent = `Image unavailable · ${label}`;
    wrapper.append(preview, fallback);
    image.replaceWith(wrapper);
  }
}
