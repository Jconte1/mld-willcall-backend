"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeRandomToken = makeRandomToken;
exports.sha256 = sha256;
const crypto_1 = __importDefault(require("crypto"));
function makeRandomToken(bytes = 32) {
    return crypto_1.default.randomBytes(bytes).toString("hex");
}
function sha256(input) {
    return crypto_1.default.createHash("sha256").update(input).digest("hex");
}
