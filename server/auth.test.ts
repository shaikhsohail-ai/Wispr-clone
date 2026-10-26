import { describe, expect, it } from 'vitest';
import { credentialsMatch } from './auth.js';

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
