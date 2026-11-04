/** The one request-size bound, read before parsing, authentication or any
 * database access. */
export const MAX_REQUEST_BYTES = 262144;

export async function boundRequest(
  request: Request,
  maximum = MAX_REQUEST_BYTES,
): Promise<Request | Response> {
  if (Number(request.headers.get("Content-Length")) > maximum)
    return Response.json({ error: "request_too_large" }, { status: 413 });
  if (!request.body) return request;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximum) {
      await reader.cancel();
      return Response.json({ error: "request_too_large" }, { status: 413 });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new Request(request, { body: bytes.buffer });
}
