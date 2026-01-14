"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.validatePasswordRules = validatePasswordRules;
exports.hashPassword = hashPassword;
exports.verifyPassword = verifyPassword;
exports.generateTempPassword = generateTempPassword;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
function validatePasswordRules(pw) {
    if (pw.length < 8)
        return { ok: false, message: "Password must be at least 8 characters." };
    if (!/[0-9]/.test(pw))
        return { ok: false, message: "Password must include at least 1 number." };
    if (!/[^A-Za-z0-9]/.test(pw))
        return { ok: false, message: "Password must include at least 1 symbol." };
    return { ok: true };
}
async function hashPassword(pw) {
    const salt = await bcryptjs_1.default.genSalt(10);
    return bcryptjs_1.default.hash(pw, salt);
}
async function verifyPassword(pw, hash) {
    return bcryptjs_1.default.compare(pw, hash);
}
function generateTempPassword(length = 14) {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    const numbers = "23456789";
    const symbols = "!@#$%^&*";
    const all = alphabet + numbers + symbols;
    // Ensure at least 1 number and 1 symbol
    const pick = (s) => s[Math.floor(Math.random() * s.length)];
    const chars = [pick(numbers), pick(symbols)];
    while (chars.length < length)
        chars.push(pick(all));
    // Shuffle
    for (let i = chars.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars.join("");
}
