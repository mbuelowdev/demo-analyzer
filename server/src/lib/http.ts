import type { FastifyRequest } from 'fastify';
import type { ApiKeyUser, SessionUser } from '../auth/session.ts';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function requireUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw new HttpError(401, 'not logged in');
  return req.user;
}

export function requireAdmin(req: FastifyRequest): SessionUser {
  const u = requireUser(req);
  if (!u.isAdmin) throw new HttpError(403, 'admin only');
  return u;
}

export function requireApiKey(req: FastifyRequest): ApiKeyUser {
  if (!req.apiKey) throw new HttpError(401, 'invalid or revoked API key');
  return req.apiKey;
}
