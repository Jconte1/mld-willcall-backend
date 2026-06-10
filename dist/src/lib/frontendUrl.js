"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getFrontendUrl = getFrontendUrl;
exports.buildFrontendPath = buildFrontendPath;
const DEFAULT_FRONTEND_URL = "https://mld-willcall.vercel.app";
function stripAccidentalEnvAssignment(value) {
    return value.replace(/^\s*frontend_url\s*=\s*/i, "").replace(/^\s*FRONTEND_URL\s*=\s*/, "").trim();
}
function getFrontendUrl() {
    const raw = process.env.FRONTEND_URL || DEFAULT_FRONTEND_URL;
    const cleaned = stripAccidentalEnvAssignment(raw).replace(/\/+$/, "");
    try {
        const parsed = new URL(cleaned);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
            throw new Error(`Unsupported protocol: ${parsed.protocol}`);
        }
        return parsed.toString().replace(/\/+$/, "");
    }
    catch (err) {
        console.error("[config] invalid FRONTEND_URL", {
            raw,
            cleaned,
            error: err instanceof Error ? err.message : String(err),
        });
        return DEFAULT_FRONTEND_URL;
    }
}
function buildFrontendPath(path) {
    const base = getFrontendUrl();
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    return `${base}${normalizedPath}`;
}
