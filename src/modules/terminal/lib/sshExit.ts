/** OpenSSH uses 255 for client/transport errors; -1 is Terax's wait-error sentinel. */
export function isSshTransportFailure(code: number): boolean {
  return code === 255 || code === -1;
}
