import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { MenuCategoryRepository } from './repositories/menu-category.repository.js';
import { MenuItemRepository } from './repositories/menu-item.repository.js';
import { MenuCategoryService } from './services/menu-category.service.js';
import { MenuItemService } from './services/menu-item.service.js';
import { MenuCategoryController } from './controllers/menu-category.controller.js';
import { MenuItemController } from './controllers/menu-item.controller.js';

/**
 * Phase 6 (menu management). Imports IdentityModule for `AuthGuard`,
 * same as RestaurantsModule — every controller here applies
 * `@UseGuards(AuthGuard, AuthorizationGuard)`.
 */
@Module({
  imports: [IdentityModule],
  controllers: [MenuCategoryController, MenuItemController],
  providers: [MenuCategoryRepository, MenuItemRepository, MenuCategoryService, MenuItemService],
  // Phase 22: exported so AdminModule can reuse the exact same menu CRUD
  // logic the owner-side controllers call, rather than duplicating it.
  exports: [MenuCategoryService, MenuItemService],
})
export class MenuModule {}
