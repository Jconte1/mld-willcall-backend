"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireAuth = requireAuth;
exports.blockIfMustChangePassword = blockIfMustChangePassword;
exports.requireRole = requireRole;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
function requireAuth(req, res, next) {
    const header = req.headers.authorization ?? "";
    const [type, token] = header.split(" ");
    if (type !== "Bearer" || !token) {
        return res.status(401).json({ message: "Missing Authorization Bearer token" });
    }
    const secret = process.env.JWT_SECRET;
    if (!secret)
        return res.status(500).json({ message: "Server misconfigured: JWT_SECRET missing" });
    try {
        const decoded = jsonwebtoken_1.default.verify(token, secret);
        req.auth = {
            id: decoded.sub,
            email: decoded.email,
            role: decoded.role,
            locationAccess: decoded.locationAccess ?? [],
            mustChangePassword: Boolean(decoded.mustChangePassword)
        };
        return next();
    }
    catch {
        return res.status(401).json({ message: "Invalid or expired token" });
    }
}
function blockIfMustChangePassword(req, res, next) {
    if (req.auth?.mustChangePassword) {
        return res.status(403).json({ code: "MUST_CHANGE_PASSWORD", message: "Password change required" });
    }
    return next();
}
function requireRole(role) {
    return (req, res, next) => {
        if (!req.auth)
            return res.status(401).json({ message: "Unauthenticated" });
        if (req.auth.role !== role)
            return res.status(403).json({ message: "Forbidden" });
        return next();
    };
}
