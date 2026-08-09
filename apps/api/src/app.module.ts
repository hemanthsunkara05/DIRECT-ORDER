import { Module } from '@nestjs/common';
import type { Env } from './platform/config/env.schema.js';
import { PlatformModule } from './platform/platform.module.js';

@Module({})
export class AppModule {
  static forRoot(env: Env) {
    return {
      module: AppModule,
      imports: [PlatformModule.forRoot(env)],
    };
  }
}
