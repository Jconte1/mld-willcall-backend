import { Request, Response, NextFunction } from "express";
import { normalizeLocationId, normalizeLocationIds } from "../lib/locationIds";

export function hasLocationAccess(locationAccess: string[], locationId: string) {
  const canonical = normalizeLocationId(locationId);
  return Boolean(canonical && normalizeLocationIds(locationAccess).includes(canonical));
}

export function requireLocationAccess(locationId: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth) return res.status(401).json({ message: "Unauthenticated" });

    if (!hasLocationAccess(req.auth.locationAccess, locationId)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    return next();
  };
}
