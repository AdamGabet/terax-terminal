/** Minimal RFC-4180-ish parser: quotes, escaped "", CRLF, custom delimiter. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\r") {
      // Skip; \n handles the break.
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  while (
    rows.length > 0 &&
    rows[rows.length - 1].every((cell) => cell === "")
  ) {
    rows.pop();
  }
  return rows;
}

/** Guess csv delimiter from a head sample (comma vs semicolon vs tab). */
export function sniffDelimiter(sample: string): string {
  const lines = sample.split("\n").slice(0, 5).join("\n");
  const commas = (lines.match(/,/g) ?? []).length;
  const semis = (lines.match(/;/g) ?? []).length;
  const tabs = (lines.match(/\t/g) ?? []).length;
  if (tabs > commas && tabs > semis) return "\t";
  if (semis > commas) return ";";
  return ",";
}
