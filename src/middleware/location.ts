import { Request, Response, NextFunction } from "express";
import { expandLocationIds } from "../lib/locationIds";

export function requireLocationAccess(locationId: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth) return res.status(401).json({ message: "Unauthenticated" });

    // Admin can access all
    if (req.auth.role === "ADMIN") return next();

    if (!expandLocationIds(req.auth.locationAccess).includes(locationId)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    return next();
  };
}
