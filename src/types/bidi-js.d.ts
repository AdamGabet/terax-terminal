declare module "bidi-js" {
  type EmbeddingLevels = {
    levels: Uint8Array;
    paragraphs: { start: number; end: number; level: number }[];
  };

  type Bidi = {
    getEmbeddingLevels(
      text: string,
      direction?: "ltr" | "rtl" | "auto",
    ): EmbeddingLevels;
    getReorderedString(text: string, levels: EmbeddingLevels): string;
  };

  export default function bidiFactory(): Bidi;
}
