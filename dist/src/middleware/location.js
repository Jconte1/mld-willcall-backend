"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireLocationAccess = requireLocationAccess;
function requireLocationAccess(locationId) {
    return (req, res, next) => {
        if (!req.auth)
            return res.status(401).json({ message: "Unauthenticated" });
        // Admin can access all
        if (req.auth.role === "ADMIN")
            return next();
        if (!req.auth.locationAccess.includes(locationId)) {
            return res.status(403).json({ message: "Forbidden" });
        }
        return next();
    };
}
