import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/** Anything shorter falls to online guessing on a public URL even with the throttle below; the server refuses to start. */
export const MIN_PASSWORD_LENGTH = 12;

export interface BasicAuthOptions {
  username: string;
  password: string;
  /** Paths served without credentials: platform health checks, the web app manifest and icon (browsers fetch a manifest without credentials). */
  open?: string[];
  /** Wrong-credential requests allowed per window before every credential check is slowed down. */
  freeFailures?: number;
  windowMs?: number;
  /** How long each credential check waits once the budget is spent. */
  delayMs?: number;
  /** Credential checks allowed to wait at the same time; further requests get 429 without being checked. */
  maxPending?: number;
  /** Receives one line per rejected attempt (never the credentials). */
  log?: (line: string) => void;
}

/**
 * HTTP Basic authentication for the whole app. Browsers ask once, then send the credentials with every
 * request to this origin (page loads and fetch calls alike), which is all a single-user app needs.
 *
 * Guessing is throttled with one global budget (per-client budgets are unreliable behind the proxies and
 * platforms this is deployed on): after `freeFailures` wrong attempts within `windowMs`, every credential
 * check (right or wrong, so the attacker cannot tell them apart) waits `delayMs`, and at most `maxPending`
 * may wait at once. That caps guessing at roughly maxPending / delayMs per second. The owner's browser only
 * sends the right credentials, so in normal use it never hits the budget; during an active flood it may see
 * a 429 and has to reload once a slot is free. Requests without any credentials are answered 401 at once and
 * are not counted, so the browser's first visit always gets its login prompt.
 *
 * A request on an open path still has its credentials checked when it carries any, and `res.locals.authenticated`
 * says whether they matched, so a route can answer an anonymous probe with less than the signed-in app gets.
 */
export function createBasicAuth({
  username,
  password,
  open = [],
  freeFailures = 10,
  windowMs = 60_000,
  delayMs = 2_000,
  maxPending = 2,
  log = console.warn,
}: BasicAuthOptions) {
  const expected = Buffer.from(`${username}:${password}`, 'utf8');
  let failures: number[] = [];
  let pending = 0;

  const challenge = (res: Response) => {
    res.setHeader('WWW-Authenticate', 'Basic realm="Wispr Clone", charset="UTF-8"');
    res.setHeader('Cache-Control', 'no-store');
    res.status(401).json({ error: 'Sign in with the Wispr Clone username and password', code: 'unauthorized' });
  };

  const check = (req: Request, res: Response, next: NextFunction) => {
    if (credentialsMatch(req.headers.authorization, expected)) {
      res.locals.authenticated = true;
      return next();
    }
    failures.push(Date.now());
    log(`[auth] rejected credentials for ${req.method} ${req.path} from ${req.ip ?? 'unknown address'}`);
    if (open.includes(req.path)) return next();
    challenge(res);
  };

  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.headers.authorization) {
      if (open.includes(req.path)) return next();
      return challenge(res);
    }
    const now = Date.now();
    failures = failures.filter((at) => now - at < windowMs);
    if (failures.length < freeFailures) return check(req, res, next);
    if (pending >= maxPending) {
      res.setHeader('Retry-After', String(Math.ceil(delayMs / 1000)));
      res.setHeader('Cache-Control', 'no-store');
      res.status(429).json({ error: 'Too many failed sign-in attempts; wait a moment and try again', code: 'too_many_attempts' });
      return;
    }
    pending++;
    setTimeout(() => {
      pending--;
      check(req, res, next);
    }, delayMs);
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
