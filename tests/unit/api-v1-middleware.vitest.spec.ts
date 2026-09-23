import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';

describe('API v1 Middleware Bypass', () => {
  it('includes /api/v1 in PUBLIC_PATH_PREFIXES source', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/middleware.ts'), 'utf8');
    expect(source).toContain("'/api/v1'");
  });

  it('allows /api/v1/upload to pass through without session cookie', () => {
    const req = new NextRequest('http://localhost:3000/api/v1/upload', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-api-key',
      },
    });

    const res = middleware(req);
    // Should NOT be 401 Unauthorized; should pass through (status 200 or next())
    expect(res.status).not.toBe(401);
  });

  it('still blocks unauthenticated requests to protected /api/ routes', () => {
    const req = new NextRequest('http://localhost:3000/api/documents', {
      method: 'GET',
    });

    const res = middleware(req);
    expect(res.status).toBe(401);
  });
});
