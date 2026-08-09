import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { GlobalExceptionFilter } from './global-exception.filter.js';

@Module({
  providers: [{ provide: APP_FILTER, useClass: GlobalExceptionFilter }],
})
export class ErrorsModule {}
