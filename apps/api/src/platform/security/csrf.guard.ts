import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { ForbiddenError } from '../errors/app-error.js';
import { CSRF_COOKIE, CSRF_HEADER, csrfTokensMatch } from './csrf.js';
import { SKIP_CSRF_KEY } from './skip-csrf.decorator.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Enforces the double-submit CSRF check (docs/09-security.md §15.7) on
 * every state-changing request. Registered globally (APP_GUARD,
 * errors.module.ts) — unlike AuthorizationGuard, this has no ordering
 * dependency on AuthGuard (it never reads `request.user`), so being
 * global is safe regardless of where it runs relative to other guards.
 *
 * GET/HEAD/OPTIONS are exempt by definition (not state-changing).
 * `@SkipCsrf()` exempts signature-authenticated webhook routes, which
 * carry no cookies at all and therefore have nothing for this check to
 * protect.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();

    if (SAFE_METHODS.has(request.method)) {
      return true;
    }

    const skip = this.reflector.get<boolean | undefined>(SKIP_CSRF_KEY, context.getHandler());
    if (skip) {
      return true;
    }

    const cookieToken = request.cookies?.[CSRF_COOKIE];
    const headerToken = request.headers[CSRF_HEADER];
    const headerValue = Array.isArray(headerToken) ? headerToken[0] : headerToken;

    if (!csrfTokensMatch(cookieToken, headerValue)) {
      throw new ForbiddenError('Missing or invalid CSRF token.');
    }

    return true;
  }
}
