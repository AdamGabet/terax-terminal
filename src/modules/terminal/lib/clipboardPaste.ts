/**
 * Clipboard paste into a terminal, with image support for SSH workspaces.
 *
 * A remote process (e.g. Claude Code over SSH) cannot see the local
 * clipboard, so pasting a screenshot does nothing. When the clipboard holds
 * an image and no plain text, we upload the bytes to the remote host. POSIX
 * receives its path; Windows puts it on the remote clipboard and sends the
 * native image-paste shortcut. Large Windows text pastes also use a temporary
 * remote file because OpenSSH/ConPTY can drop bytes from terminal input.
 */

import { invoke } from "@tauri-apps/api/core";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { currentWorkspaceEnv, getSshHome } from "@/modules/workspace";

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
};

type PasteTarget = {
  paste: (text: string) => void;
  sendInput?: (text: string) => void;
};

export function isLargePaste(text: string): boolean {
  return text.length > 800 || text.split(/\r?\n/).length > 2;
}

export function remotePastePaths(
  home: string,
  platform: "posix" | "windows" | undefined,
  filename: string,
): { uploadPath: string; pastePath: string } {
  const uploadPath = `${home.replace(/[\\/]+$/, "")}/.cache/terax/remote/${filename}`;
  return {
    uploadPath,
    pastePath:
      platform === "windows" ? uploadPath.replace(/\//g, "\\") : uploadPath,
  };
}

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

  // Read text via the Tauri clipboard plugin (native OS access). Unlike
  // navigator.clipboard.readText(), it doesn't trip the macOS WKWebView "Paste"
  // confirmation, so a normal Cmd+V pastes immediately. Text wins when both a
  // string and an image are present, matching the previous behaviour.
  try {
    const text = await readText();
    if (text) {
      if (
        env.kind === "ssh" &&
        env.platform === "windows" &&
        isLargePaste(text)
      ) {
        const home = await getSshHome(env.host);
        const { uploadPath, pastePath } = remotePastePaths(
          home,
          env.platform,
          `paste-${Date.now()}.txt`,
        );
        await invoke("fs_write_file", {
          path: uploadPath,
          content: text,
          workspace: env,
        });
        target.paste(
          `Read the complete text I pasted from "${pastePath}" and treat its exact contents as my prompt. `,
        );
        return;
      }
      target.paste(text);
      return;
    }
  } catch {
    // Plugin read failed — fall through to the image path (SSH) or give up.
  }

  if (env.kind === "ssh") {
    const image = await readClipboardImage();
    if (image) {
      try {
        const home = await getSshHome(env.host);
        const ext = EXT_BY_MIME[image.type] ?? "png";
        const { uploadPath, pastePath } = remotePastePaths(
          home,
          env.platform,
          `paste-${Date.now()}.${ext}`,
        );
        await invoke("fs_write_file_base64", {
          path: uploadPath,
          base64: await blobToBase64(image),
          workspace: env,
        });
        if (env.platform === "windows" && target.sendInput) {
          await invoke("ssh_set_clipboard_image", {
            host: env.host,
            path: uploadPath,
          });
          // Claude Code's documented Windows image-paste binding is Alt+V.
          // Send it as terminal input, not bracketed paste content.
          target.sendInput("\x1bv");
          return;
        }
        // Trailing space: Claude Code detects a pasted absolute image path
        // and auto-attaches it as an inline image; the delimiter helps the
        // detection trigger (and is harmless at a shell prompt).
        target.paste(`${pastePath} `);
      } catch (e) {
        console.warn("[terax] clipboard image upload failed:", e);
      }
    }
  }
}
