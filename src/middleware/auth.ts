import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export type AuthUser = {
  id: string;
  email: string;
  role: "ADMIN" | "STAFF";
  locationAccess: string[];
  mustChangePassword: boolean;
};

declare global {
  namespace Express {
    interface Request {
      auth?: AuthUser;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  const [type, token] = header.split(" ");

  if (type !== "Bearer" || !token) {
    return res.status(401).json({ message: "Missing Authorization Bearer token" });
  }

  const secret = process.env.JWT_SECRET;
  if (!secret) return res.status(500).json({ message: "Server misconfigured: JWT_SECRET missing" });

  try {
    const decoded = jwt.verify(token, secret) as any;

    req.auth = {
      id: decoded.sub,
      email: decoded.email,
      role: decoded.role,
      locationAccess: decoded.locationAccess ?? [],
      mustChangePassword: Boolean(decoded.mustChangePassword)
    };

    return next();
  } catch {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}

export function blockIfMustChangePassword(req: Request, res: Response, next: NextFunction) {
  if (req.auth?.mustChangePassword) {
    return res.status(403).json({ code: "MUST_CHANGE_PASSWORD", message: "Password change required" });
  }
  return next();
}

export function requireRole(role: "ADMIN" | "STAFF") {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth) return res.status(401).json({ message: "Unauthenticated" });
    if (req.auth.role !== role) return res.status(403).json({ message: "Forbidden" });
    return next();
  };
}
