import { Inject, Injectable } from '@nestjs/common';
import type { Restaurant } from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';
import { AuditService } from '../../../platform/audit/audit.service.js';
import { ConflictError, ValidationError } from '../../../platform/errors/app-error.js';
import { RestaurantRepository } from '../repositories/restaurant.repository.js';
import { slugify, validateSlugFormat } from '../slug.js';

export interface CreateRestaurantInput {
  name: string;
  slug?: string;
  description?: string;
  phone?: string;
  email?: string;
  timezone?: string;
}

const MAX_SLUG_ATTEMPTS = 50;

/**
 * The one place a Restaurant row is created (docs/13-implementation-phases.md
 * Phase 5). `ownerId` always comes from the authenticated principal, never
 * the request body (docs/14-acceptance-criteria.md: "POST /restaurants
 * with ownerId set to another user creates the restaurant owned by the
 * authenticated user" — CreateRestaurantInput has no ownerId field at
 * all, so there is nothing for a client to override).
 */
@Injectable()
export class RestaurantService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RestaurantRepository) private readonly restaurants: RestaurantRepository,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async createRestaurant(ownerId: string, input: CreateRestaurantInput): Promise<Restaurant> {
    const slug = input.slug
      ? await this.validateExplicitSlug(input.slug)
      : await this.generateUniqueSlug(input.name);

    // Restaurant + its OWNER membership + a default-valued Settings row
    // are created atomically — a Restaurant that exists but has no
    // owner (transaction partially failed) would be unreachable by any
    // principal, and RestaurantSettings' columns all have database
    // defaults, so creating it now means GET /restaurant/settings never
    // 404s for a restaurant that exists.
    const restaurant = await this.prisma.$transaction(async (tx) => {
      const created = await tx.restaurant.create({
        data: {
          slug,
          name: input.name,
          description: input.description,
          phone: input.phone,
          email: input.email,
          timezone: input.timezone,
          // Creating a restaurant IS starting onboarding — the wizard
          // has nothing left to do to move it out of NOT_STARTED.
          onboardingStatus: 'IN_PROGRESS',
        },
      });
      await tx.restaurantStaff.create({
        data: { restaurantId: created.id, userId: ownerId, role: 'OWNER' },
      });
      await tx.restaurantSettings.create({
        data: { restaurantId: created.id },
      });
      return created;
    });

    await this.audit.record({
      actorType: 'RESTAURANT_USER',
      actorId: ownerId,
      action: 'RESTAURANT_CREATED',
      entityType: 'Restaurant',
      entityId: restaurant.id,
      restaurantId: restaurant.id,
    });

    return restaurant;
  }

  /**
   * A client-chosen slug is REJECTED, not silently adjusted, on either
   * failure — docs/14-acceptance-criteria.md: "a reserved slug ...
   * is rejected with a clear message." Auto-disambiguating a taken slug
   * the owner explicitly typed would silently give them a different URL
   * than the one they asked for, which is worse than just telling them
   * to pick another.
   */
  private async validateExplicitSlug(slug: string): Promise<string> {
    const issues = validateSlugFormat(slug);
    if (issues.includes('RESERVED')) {
      throw new ValidationError(
        `"${slug}" is a reserved word and cannot be used as a restaurant URL.`,
      );
    }
    if (issues.length > 0) {
      throw new ValidationError(`"${slug}" is not a valid restaurant URL.`);
    }
    if (await this.restaurants.slugExists(slug)) {
      throw new ConflictError(`The URL "${slug}" is already taken.`);
    }
    return slug;
  }

  private async generateUniqueSlug(name: string): Promise<string> {
    const base = slugify(name);
    if (validateSlugFormat(base).includes('RESERVED')) {
      // A generated candidate landing on a reserved word (e.g. a
      // restaurant literally named "Admin") is disambiguated exactly
      // like a collision — appending -2 escapes the reserved list too,
      // since RESERVED_SLUGS is a fixed, non-numbered set.
      return this.disambiguate(`${base}-2`);
    }
    return this.disambiguate(base);
  }

  private async disambiguate(base: string): Promise<string> {
    let candidate = base;
    for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt++) {
      if (!(await this.restaurants.slugExists(candidate))) {
        return candidate;
      }
      candidate = `${base}-${attempt + 1}`;
    }
    throw new ValidationError('Could not generate a unique slug for this restaurant name.');
  }
}
