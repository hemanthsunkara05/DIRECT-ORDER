import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Customer } from '@prisma/client';
import type { CustomerScopedRequest } from '../guards/customer-account.guard.js';

/** Only valid on routes guarded by `CustomerAccountGuard` — same "no fallback lookup, fail loudly" contract as `@CurrentUser()`. */
export const CurrentCustomer = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Customer => {
    const request = ctx.switchToHttp().getRequest<CustomerScopedRequest>();
    if (!request.customer) {
      throw new Error('CurrentCustomer() used on a route without CustomerAccountGuard applied.');
    }
    return request.customer;
  },
);
