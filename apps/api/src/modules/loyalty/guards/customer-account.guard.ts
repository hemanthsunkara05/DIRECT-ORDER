import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Customer } from '@prisma/client';
import { ForbiddenError, UnauthenticatedError } from '../../../platform/errors/app-error.js';
import type { AuthenticatedRequest } from '../../identity/guards/auth.guard.js';
import { CustomerRepository } from '../../orders/repositories/customer.repository.js';

export interface CustomerScopedRequest extends AuthenticatedRequest {
  customer: Customer;
}

/**
 * The `/me/*` counterpart to `AuthorizationGuard`'s tenant/admin
 * resolution — simpler by construction, since a customer has no role
 * matrix to check, only "does this authenticated User have a Customer
 * profile at all." MUST run after `AuthGuard` (same ordering
 * requirement `AuthorizationGuard` documents on itself): `@UseGuards
 * (AuthGuard, CustomerAccountGuard)` on every `/me/loyalty*` and
 * `/me/referrals` route. A staff or admin User with no Customer row
 * (the overwhelmingly common case for those principals) gets a 403,
 * not a 401 — they ARE authenticated, they just aren't a customer.
 */
@Injectable()
export class CustomerAccountGuard implements CanActivate {
  constructor(@Inject(CustomerRepository) private readonly customers: CustomerRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.user) {
      throw new UnauthenticatedError();
    }

    const customer = await this.customers.findByUserId(request.user.id);
    if (!customer) {
      throw new ForbiddenError('This account has no customer profile.');
    }

    (request as CustomerScopedRequest).customer = customer;
    return true;
  }
}
