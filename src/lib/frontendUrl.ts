const DEFAULT_FRONTEND_URL = "https://mld-willcall.vercel.app";

function stripAccidentalEnvAssignment(value: string) {
  return value.replace(/^\s*frontend_url\s*=\s*/i, "").replace(/^\s*FRONTEND_URL\s*=\s*/, "").trim();
}

export function getFrontendUrl() {
  const raw = process.env.FRONTEND_URL || DEFAULT_FRONTEND_URL;
  const cleaned = stripAccidentalEnvAssignment(raw).replace(/\/+$/, "");

  try {
    const parsed = new URL(cleaned);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error(`Unsupported protocol: ${parsed.protocol}`);
    }
    return parsed.toString().replace(/\/+$/, "");
  } catch (err) {
    console.error("[config] invalid FRONTEND_URL", {
      raw,
      cleaned,
      error: err instanceof Error ? err.message : String(err),
    });
    return DEFAULT_FRONTEND_URL;
  }
}

export function buildFrontendPath(path: string) {
  const base = getFrontendUrl();
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}
