"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAcumaticaService = createAcumaticaService;
const acumaticaService_1 = __importDefault(require("./auth/acumaticaService"));
function requireEnv(name) {
    const v = process.env[name]?.trim();
    if (!v) {
        throw new Error(`Missing env var: ${name}`);
    }
    return v;
}
function createAcumaticaService() {
    return new acumaticaService_1.default(requireEnv("ACUMATICA_BASE_URL"), requireEnv("ACUMATICA_CLIENT_ID"), requireEnv("ACUMATICA_CLIENT_SECRET"), requireEnv("ACUMATICA_USERNAME"), requireEnv("ACUMATICA_PASSWORD"));
}
