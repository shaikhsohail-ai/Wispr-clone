import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createBasicAuth, credentialsMatch, type BasicAuthOptions } from './auth.js';

const expected = Buffer.from('wispr:s3cret');
const header = (value: string) => `Basic ${Buffer.from(value).toString('base64')}`;

describe('credentialsMatch', () => {
  it('accepts the exact user:password pair', () => {
    expect(credentialsMatch(header('wispr:s3cret'), expected)).toBe(true);
    expect(credentialsMatch(header('wispr:s3cret').replace('Basic', 'BASIC'), expected)).toBe(true);
  });

  it('rejects wrong, missing or malformed credentials', () => {
    expect(credentialsMatch(undefined, expected)).toBe(false);
    expect(credentialsMatch('', expected)).toBe(false);
    expect(credentialsMatch(header('wispr:wrong'), expected)).toBe(false);
    expect(credentialsMatch(header('other:s3cret'), expected)).toBe(false);
    expect(credentialsMatch(header('wispr:s3cret!'), expected)).toBe(false);
    expect(credentialsMatch(header('wispr:s3cre'), expected)).toBe(false);
    expect(credentialsMatch('Bearer abc', expected)).toBe(false);
    expect(credentialsMatch('Basic not*base64', expected)).toBe(false);
  });
});

describe('createBasicAuth', () => {
  const right = header('wispr:s3cret');
  const wrong = header('wispr:guess');

  /** A tiny app behind the middleware; every route reports whether the credentials matched. */
  function build(options: Partial<BasicAuthOptions> = {}) {
    const log: string[] = [];
    const app = express();
    app.use(createBasicAuth({ username: 'wispr', password: 's3cret', open: ['/open'], log: (line) => log.push(line), ...options }));
    app.get(['/private', '/open'], (_req, res) => res.json({ authenticated: Boolean(res.locals.authenticated) }));
    return { app, log };
  }

  it('challenges requests without credentials and lets open paths through, reporting who is signed in', async () => {
    const { app, log } = build();
    const denied = await request(app).get('/private');
    expect(denied.status).toBe(401);
    expect(denied.headers['www-authenticate']).toMatch(/^Basic realm=/);
    expect((await request(app).get('/open')).body).toEqual({ authenticated: false });
    expect((await request(app).get('/open').set('Authorization', right)).body).toEqual({ authenticated: true });
    expect((await request(app).get('/private').set('Authorization', right)).body).toEqual({ authenticated: true });
    expect(log).toEqual([]); // a missing header is the browser's first visit, not a guess
    const wrongOnOpen = await request(app).get('/open').set('Authorization', wrong);
    expect(wrongOnOpen.body).toEqual({ authenticated: false });
    expect((await request(app).get('/private').set('Authorization', wrong)).status).toBe(401);
    expect(log).toHaveLength(2);
    expect(log[0]).toMatch(/^\[auth\] rejected credentials for GET \/open from /);
    expect(log.join('\n')).not.toContain('guess');
  });

  it('slows every credential check down once the failure budget is spent, without locking the owner out', async () => {
    const delayMs = 150;
    const { app, log } = build({ freeFailures: 2, windowMs: 60_000, delayMs, maxPending: 1 });
    for (let i = 0; i < 2; i++) expect((await request(app).get('/private').set('Authorization', wrong)).status).toBe(401);
    expect(log).toHaveLength(2);

    // Budget spent: one guess waits for the delay, a second one at the same time is refused unchecked.
    const started = Date.now();
    const [first, second] = await Promise.all([
      request(app).get('/private').set('Authorization', wrong),
      new Promise<request.Response>((resolve) => setTimeout(() => resolve(request(app).get('/private').set('Authorization', wrong)), 30)),
    ]);
    expect(first.status).toBe(401);
    expect(Date.now() - started).toBeGreaterThanOrEqual(delayMs - 10);
    expect(second.status).toBe(429);
    expect(second.headers['retry-after']).toBe('1');
    expect(second.body.code).toBe('too_many_attempts');
    expect(log).toHaveLength(3); // the 429 was never checked, so it is not a failure

    // The right password still gets in, just after the delay, and a missing header is still answered at once.
    const before = Date.now();
    const owner = await request(app).get('/private').set('Authorization', right);
    expect(owner.status).toBe(200);
    expect(Date.now() - before).toBeGreaterThanOrEqual(delayMs - 10);
    const prompt = await request(app).get('/private');
    expect(prompt.status).toBe(401);
    expect(Date.now() - before).toBeLessThan(2 * delayMs);
    expect((await request(app).get('/open')).status).toBe(200);
  });

  it('forgets failures once the window has passed', async () => {
    const { app } = build({ freeFailures: 1, windowMs: 100, delayMs: 1_000, maxPending: 1 });
    expect((await request(app).get('/private').set('Authorization', wrong)).status).toBe(401);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const started = Date.now();
    expect((await request(app).get('/private').set('Authorization', wrong)).status).toBe(401);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
