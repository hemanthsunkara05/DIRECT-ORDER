import { DynamicModule, Global, Module } from '@nestjs/common';
import type { Env } from './env.schema.js';

export const APP_CONFIG = Symbol('APP_CONFIG');

/**
 * Provides the already-validated `Env` object (see main.ts, which calls
 * `validateEnv(process.env)` once before the Nest app is even created)
 * to the rest of the application via DI, so no other module reads
 * `process.env` directly.
 */
@Global()
@Module({})
export class ConfigModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: env }],
      exports: [APP_CONFIG],
    };
  }
}
