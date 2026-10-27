import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma";
import { normalizeLocationIds } from "../lib/locationIds";

export type AuthUser = {
  id: string;
  email: string;
  name?: string | null;
  role: "ADMIN" | "STAFF" | "VIEWER" | "SALESPERSON";
  locationAccess: string[];
  mustChangePassword: boolean;
  mustCompleteProfile?: boolean;
};

declare global {
  namespace Express {
    interface Request {
      auth?: AuthUser;
    }
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  const [type, token] = header.split(" ");

  if (type !== "Bearer" || !token) {
    return res.status(401).json({ message: "Missing Authorization Bearer token" });
  }

  const secret = process.env.JWT_SECRET;
  if (!secret) return res.status(500).json({ message: "Server misconfigured: JWT_SECRET missing" });

  let staffId: string;
  try {
    const decoded = jwt.verify(token, secret, { algorithms: ["HS256"] });
    if (typeof decoded === "string" || typeof decoded.sub !== "string" || !decoded.sub) {
      return res.status(401).json({ message: "Invalid session" });
    }
    staffId = decoded.sub;
  } catch (err) {
    console.warn("[auth] invalid token", {
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(401).json({ message: "Session expired. Please logout and log back in." });
  }

  try {
    // Tokens identify the account; only the current database record grants access.
    const staff = await prisma.staffUser.findUnique({
      where: { id: staffId },
      select: {
        id: true, email: true, name: true, role: true, locationAccess: true,
        isActive: true, mustChangePassword: true, salespersonNumber: true, salespersonName: true,
      },
    });
    if (!staff?.isActive) return res.status(401).json({ message: "Account is no longer active. Please sign in again." });
    if (!["ADMIN", "STAFF", "VIEWER", "SALESPERSON"].includes(staff.role)) {
      return res.status(403).json({ message: "Unsupported staff role" });
    }
    req.auth = {
      id: staff.id,
      email: staff.email,
      name: staff.name,
      role: staff.role as AuthUser["role"],
      locationAccess: normalizeLocationIds(staff.locationAccess ?? []),
      mustChangePassword: staff.mustChangePassword,
      mustCompleteProfile: staff.role === "SALESPERSON" && !(staff.salespersonNumber && staff.salespersonName),
    };
  } catch (err) {
    console.error("[auth] permission lookup failed", { error: err instanceof Error ? err.message : String(err) });
    return res.status(503).json({ message: "Unable to verify account permissions. Please try again." });
  }
  return next();
}

export function blockIfMustChangePassword(req: Request, res: Response, next: NextFunction) {
  if (req.auth?.mustChangePassword) {
    return res.status(403).json({ code: "MUST_CHANGE_PASSWORD", message: "Password change required" });
  }
  return next();
}

export function blockIfMustCompleteProfile(req: Request, res: Response, next: NextFunction) {
  if (req.auth?.mustCompleteProfile) {
    return res.status(403).json({ code: "MUST_COMPLETE_PROFILE", message: "Profile completion required" });
  }
  return next();
}

export function requireRole(role: "ADMIN" | "STAFF" | "VIEWER" | "SALESPERSON") {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth) return res.status(401).json({ message: "Unauthenticated" });
    if (req.auth.role !== role) return res.status(403).json({ message: "Forbidden" });
    return next();
  };
}
