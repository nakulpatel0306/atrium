// One rule for every .env guard: any path segment whose name starts or ends with ".env", in any case. That
// covers `.env.local`, `.ENV.local`, `prod.env`, and anything inside a `.env.d/` folder, but not `my.env.txt`.
export const isEnvPath = (path: string): boolean =>
  path.split(/[\\/]+/).some((seg) => /^\.env/i.test(seg) || /\.env$/i.test(seg));

// The same names as globs, for tools that take glob patterns (Claude's permission rules and sandbox paths).
// APFS is case-insensitive, so `.ENV` opens `.env`; each letter's case is spelled out.
const ENV = "[eE][nN][vV]";
export const ENV_GLOBS = [`.${ENV}*`, `*.${ENV}`];
