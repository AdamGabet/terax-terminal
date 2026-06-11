export type PreviewKind = "image" | "pdf";

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  avif: "image/avif",
};

export const PREVIEWABLE_EXTENSIONS = [...Object.keys(IMAGE_MIME), "pdf"];

function extOf(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return "";
  return path.slice(dot + 1).toLowerCase();
}

/** "image" / "pdf" when the path can be shown in a file-preview tab. */
export function previewKindForPath(path: string): PreviewKind | null {
  const ext = extOf(path);
  if (ext === "pdf") return "pdf";
  if (ext in IMAGE_MIME) return "image";
  return null;
}

export function mimeForPath(path: string): string {
  const ext = extOf(path);
  if (ext === "pdf") return "application/pdf";
  return IMAGE_MIME[ext] ?? "application/octet-stream";
}
