/**
 * Clipboard paste into a terminal, with image support for SSH workspaces.
 *
 * A remote process (e.g. Claude Code over SSH) cannot see the local
 * clipboard, so pasting a screenshot does nothing. When the clipboard holds
 * an image and no plain text, we upload the bytes to a temp file on the
 * remote host and paste its path instead — the same UX as dropping a file
 * onto the terminal. Plain text falls through to a normal paste.
 */

import { invoke } from "@tauri-apps/api/core";
import { currentWorkspaceEnv, getSshHome } from "@/modules/workspace";

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
};

type PasteTarget = { paste: (text: string) => void };

async function blobToBase64(blob: Blob): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

/** Image-only clipboard → blob, otherwise null (text wins when both exist). */
async function readClipboardImage(): Promise<Blob | null> {
  if (!navigator.clipboard.read) return null;
  let items: ClipboardItems;
  try {
    items = await navigator.clipboard.read();
  } catch {
    return null;
  }
  for (const item of items) {
    if (item.types.includes("text/plain")) return null;
    const mime = item.types.find((t) => t in EXT_BY_MIME);
    if (mime) {
      try {
        return await item.getType(mime);
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Paste the clipboard into `target`. Returns once the paste was written.
 * Failures degrade to pasting whatever text is available (or nothing).
 */
export async function pasteClipboard(target: PasteTarget): Promise<void> {
  const env = currentWorkspaceEnv();
  if (env.kind === "ssh") {
    const image = await readClipboardImage();
    if (image) {
      try {
        const home = await getSshHome(env.host);
        const ext = EXT_BY_MIME[image.type] ?? "png";
        const remotePath = `${home}/.cache/terax/remote/paste-${Date.now()}.${ext}`;
        await invoke("fs_write_file_base64", {
          path: remotePath,
          base64: await blobToBase64(image),
          workspace: env,
        });
        // Trailing space: Claude Code detects a pasted absolute image path
        // and auto-attaches it as an inline image; the delimiter helps the
        // detection trigger (and is harmless at a shell prompt).
        target.paste(`${remotePath} `);
        return;
      } catch (e) {
        console.warn("[terax] clipboard image upload failed:", e);
        return;
      }
    }
  }
  try {
    const text = await navigator.clipboard.readText();
    if (text) target.paste(text);
  } catch {
    // Clipboard unavailable — nothing to paste.
  }
}
