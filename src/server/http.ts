export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const json = (body: unknown, status = 200) => Response.json(body, { status });
export const fail = (status: number, message: string) => json({ error: message }, status);

export const str = (v: unknown, field: string): string => {
  if (typeof v !== "string" || !v.trim()) throw new HttpError(400, `${field} is required.`);
  return v;
};
export const opt = <T>(v: unknown, ok: (x: unknown) => x is T, field: string): T | undefined => {
  if (v === undefined) return undefined;
  if (!ok(v)) throw new HttpError(400, `${field} is not valid.`);
  return v;
};
export const isBool = (x: unknown): x is boolean => typeof x === "boolean";
export const isString = (x: unknown): x is string => typeof x === "string";

// With a limit, an oversized body is refused before it's parsed: by its Content-Length, or while streaming it in.
export const readBody = async (req: Request, limit?: { bytes: number; message: string }): Promise<Record<string, unknown>> => {
  if (!req.body) return {};
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "Send the request body as application/json.");
  }
  let body: unknown;
  try {
    if (!limit) body = await req.json();
    else {
      if (Number(req.headers.get("content-length") ?? 0) > limit.bytes) throw new HttpError(413, limit.message);
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = req.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit.bytes) {
          await reader.cancel();
          throw new HttpError(413, limit.message);
        }
        chunks.push(value);
      }
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, "The request body isn't valid JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "The request body must be a JSON object.");
  }
  return body as Record<string, unknown>;
};
