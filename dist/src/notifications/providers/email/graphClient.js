"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getGraphAccessToken = getGraphAccessToken;
const node_fetch_1 = __importDefault(require("node-fetch"));
async function getGraphAccessToken() {
    const tenantId = process.env.MS_GRAPH_TENANT_ID || "";
    const clientId = process.env.MS_GRAPH_CLIENT_ID || "";
    const clientSecret = process.env.MS_GRAPH_CLIENT_SECRET || "";
    if (!tenantId || !clientId || !clientSecret) {
        console.warn("[notifications][graph] missing env vars");
        throw new Error("Microsoft Graph env vars are missing");
    }
    const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
    const body = new URLSearchParams();
    body.set("client_id", clientId);
    body.set("client_secret", clientSecret);
    body.set("scope", "https://graph.microsoft.com/.default");
    body.set("grant_type", "client_credentials");
    const resp = await (0, node_fetch_1.default)(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
    });
    if (!resp.ok) {
        const text = await resp.text();
        console.error("[notifications][graph] token request failed", resp.status, text);
        throw new Error(`Graph token failed: ${resp.status} ${text}`);
    }
    const json = (await resp.json());
    if (!json.access_token)
        throw new Error("Graph token missing access_token");
    console.log("[notifications][graph] token acquired");
    return json.access_token;
}
