export function externalChatUrl(target: string): string | undefined {
  if (/[\u0000-\u001f\u007f]/.test(target) || !/^(https?:\/\/|mailto:)/i.test(target)) return;
  try {
    const url = new URL(target);
    if (url.protocol === "mailto:" ? url.pathname : url.hostname) return url.href;
  } catch { /* malformed URL */ }
}

export interface ChatFileLink {
  path: string;
  line?: number;
  column?: number;
}

/** Markdown destinations can be paths with :line[:column] or GitHub-style #Lline. */
export function chatFileLink(target: string): ChatFileLink | undefined {
  if (!target || /[\u0000-\u001f\u007f]/.test(target)) return;
  const position = /#L([1-9]\d*)$|:([1-9]\d*)(?::([1-9]\d*))?$/.exec(target);
  let path = position ? target.slice(0, position.index) : target;
  try {
    if (/^file:\/\//i.test(path)) {
      const uri = new URL(path);
      if (uri.hostname || uri.search || uri.hash) return;
      path = uri.pathname.replace(/^\/(?=[A-Za-z]:\/)/, "");
    }
    path = decodeURIComponent(path);
  } catch { return; }
  if (!path || /[\u0000-\u001f\u007f?#]/.test(path) || /^(?:\/\/|\\\\)/.test(path)) return;
  const windows = /^[A-Za-z]:[\\/]/.test(path);
  if (!windows && path.includes(":")) return;
  if (!windows && !/[\\/]|\.[\w-]+$/.test(path)) return;
  const line = position ? Number(position[1] ?? position[2]) : undefined;
  const column = position?.[3] ? Number(position[3]) : undefined;
  if ((line !== undefined && !Number.isSafeInteger(line)) || (column !== undefined && !Number.isSafeInteger(column))) return;
  return { path, line, column };
}
