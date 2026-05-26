const DEFAULT_FRONTEND_BASE_URL = "https://mld-willcall.vercel.app";

function stripTrailingSlashes(value: string) {
  return value.trim().replace(/\/+$/, "");
}

function toOrigin(value: string) {
  const normalized = stripTrailingSlashes(value);
  if (!normalized) return "";

  try {
    return new URL(normalized).origin;
  } catch {
    return normalized;
  }
}

export function getConfiguredFrontendBaseUrl() {
  return stripTrailingSlashes(process.env.FRONTEND_URL || "");
}

export function getFrontendBaseUrl() {
  return getConfiguredFrontendBaseUrl() || DEFAULT_FRONTEND_BASE_URL;
}

export function getCorsOrigins(): string | string[] {
  const explicit = process.env.CORS_ORIGIN?.trim();
  if (explicit) {
    const origins = explicit.split(",").map(toOrigin).filter(Boolean);
    if (origins.length === 1) return origins[0];
    if (origins.length > 1) return origins;
  }

  return toOrigin(getFrontendBaseUrl());
}

export function getBackendBaseUrl() {
  const explicit = process.env.BACKEND_URL || process.env.BACKEND_API_URL;
  if (explicit) return stripTrailingSlashes(explicit);
  if (process.env.VERCEL_URL) return stripTrailingSlashes(`https://${process.env.VERCEL_URL}`);
  return "";
}
