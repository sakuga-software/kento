/** The body was larger than the limit. The reader stopped at the limit. */
export class BodyTooLargeError extends Error {
  override name = 'BodyTooLargeError'
}

/**
 * Reads the whole body of a request, and stops with `BodyTooLargeError` as soon as it passes
 * `maxBytes`. A `Content-Length` above the limit fails before the first byte is read. The check on the
 * stream also covers a chunked body, and a `Content-Length` that lies.
 */
export async function readBodyLimited(request: Request, maxBytes: number): Promise<Uint8Array> {
  let declared = request.headers.get('Content-Length')
  if (declared !== null && Number(declared) > maxBytes) {
    throw new BodyTooLargeError(`body of ${declared} bytes, limit ${maxBytes}`)
  }
  if (request.body === null) return new Uint8Array(0)

  let reader = request.body.getReader()
  let chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      let next = await reader.read()
      if (next.done) break
      let value = next.value
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        throw new BodyTooLargeError(`body over the limit of ${maxBytes} bytes`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  let body = new Uint8Array(size)
  let offset = 0
  for (let chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}
