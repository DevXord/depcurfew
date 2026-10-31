/** The whole of stdin as text, up to `limit` bytes. */
export async function readStdin(limit = 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.byteLength;
    if (size > limit) throw new Error(`stdin is larger than ${limit / (1024 * 1024)} MiB`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
