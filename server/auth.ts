import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export interface BasicAuthOptions {
  username: string;
  password: string;
  /** Paths that stay open, for platform health checks. */
  open?: string[];
}

/**
 * HTTP Basic authentication for the whole app. Browsers ask once, then send the credentials with every
 * request to this origin (page loads and fetch calls alike), which is all a single-user app needs.
 */
export function createBasicAuth({ username, password, open = [] }: BasicAuthOptions) {
  const expected = Buffer.from(`${username}:${password}`, 'utf8');
  return (req: Request, res: Response, next: NextFunction) => {
    if (open.includes(req.path)) return next();
    if (credentialsMatch(req.headers.authorization, expected)) return next();
    res.setHeader('WWW-Authenticate', 'Basic realm="Wispr Clone", charset="UTF-8"');
    res.setHeader('Cache-Control', 'no-store');
    res.status(401).json({ error: 'Sign in with the Wispr Clone username and password', code: 'unauthorized' });
  };
}

/** Constant-time comparison of an `Authorization: Basic` header against the expected `user:password`. */
export function credentialsMatch(header: string | undefined, expected: Buffer): boolean {
  if (!header) return false;
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header.trim());
  if (!match) return false;
  const provided = Buffer.from(match[1], 'base64');
  if (provided.length !== expected.length) {
    // Burn the same comparison time so the length of the secret does not leak.
    timingSafeEqual(expected, expected);
    return false;
  }
  return timingSafeEqual(provided, expected);
}
