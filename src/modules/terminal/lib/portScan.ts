const MIN_PORT = 1024;

export function scanLocalhostPorts(text: string): number[] {
  const ports: number[] = [];
  const seen = new Set<number>();
  const re = /\blocalhost:(\d{1,5})\b/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const port = Number(match[1]);
    if (port < MIN_PORT || port > 65535 || seen.has(port)) continue;
    seen.add(port);
    ports.push(port);
  }
  return ports;
}
