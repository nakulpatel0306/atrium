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

export const readBody = async (req: Request): Promise<Record<string, unknown>> => {
  if (!req.body) return {};
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "Send the request body as application/json.");
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, "The request body isn't valid JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "The request body must be a JSON object.");
  }
  return body as Record<string, unknown>;
};
