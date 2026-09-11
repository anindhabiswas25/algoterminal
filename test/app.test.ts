import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { Hono } from 'hono';
import { createApp } from '../src/app.js';
import { ApiError, envelope } from '../src/errors.js';

// The standard error envelope, API_SPEC.md §5.
const ErrorSchema = z.object({
  error: z.object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'must be UPPER_SNAKE'),
    message: z.string().min(1),
    detail: z.record(z.string(), z.unknown()),
  }),
});

describe('error envelope', () => {
  it('matches the API_SPEC.md §5 shape', () => {
    expect(() => ErrorSchema.parse(envelope('BAD_REQUEST', 'nope', { field: 'x' }))).not.toThrow();
  });
});

describe('404 handler', () => {
  it('returns the standard envelope', async () => {
    const res = await createApp().request('/no-such-route');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(() => ErrorSchema.parse(body)).not.toThrow();
    expect(body.error.code).toBe('NOT_FOUND');
  });
});

describe('global error handler', () => {
  it('maps an ApiError to its status and code', async () => {
    const app = createApp();
    app.get('/boom-api', () => {
      throw new ApiError(422, 'UPSTREAM_SCHEMA_DRIFT', 'Upstream payload failed validation', {
        connector: 'alpha',
      });
    });

    const res = await app.request('/boom-api');
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(() => ErrorSchema.parse(body)).not.toThrow();
    expect(body.error.code).toBe('UPSTREAM_SCHEMA_DRIFT');
    expect(body.error.detail).toEqual({ connector: 'alpha' });
  });

  it('maps an unexpected throw to a 500 INTERNAL_ERROR envelope', async () => {
    const app = createApp();
    app.get('/boom', () => {
      throw new Error('kaboom: secret connection string');
    });

    const res = await app.request('/boom');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(() => ErrorSchema.parse(body)).not.toThrow();
    expect(body.error.code).toBe('INTERNAL_ERROR');
    // NODE_ENV=test, so internals stay out of the response.
    expect(JSON.stringify(body)).not.toContain('secret connection string');
  });
});

describe('static landing page', () => {
  it('serves public/index.html at the root', async () => {
    const res = await createApp().request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('<html');
  });
});

describe('type sanity', () => {
  it('createApp returns a Hono instance', () => {
    expect(createApp()).toBeInstanceOf(Hono);
  });
});
