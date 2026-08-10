import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { APP_GUARD } from '@nestjs/core';
import { UserRepository } from './repositories/user.repository.js';
import { SessionRepository } from './repositories/session.repository.js';
import { OtpChallengeRepository } from './repositories/otp-challenge.repository.js';
import { PasswordService } from './services/password.service.js';
import { TokenService } from './services/token.service.js';
import { SessionService } from './services/session.service.js';
import { OtpService } from './services/otp.service.js';
import { AuthNotifierService } from './services/auth-notifier.service.js';
import { LoginThrottleService } from './services/login-throttle.service.js';
import { AuthService } from './services/auth.service.js';
import { AuthGuard } from './guards/auth.guard.js';
import { AuthController } from './controllers/auth.controller.js';
import { RateLimitGuard } from '../../platform/rate-limit/rate-limit.guard.js';

/**
 * Registration, login, session lifecycle, password reset, and email/phone
 * verification (Phase 3). `JwtModule.register({})` with no default
 * options is deliberate — TokenService passes `secret` and `expiresIn`
 * explicitly on every sign/verify call (docs/09-security.md §15.2: the
 * secret comes from validated env, not a module-level default that could
 * silently diverge from it), so JwtModule here exists only to make
 * `JwtService` injectable.
 *
 * RateLimitGuard is registered here as APP_GUARD (applies to every route
 * in the app, not just this module) because Redis-backed rate limiting
 * is the first cross-cutting HTTP concern with a real dependency
 * (Redis) — see RateLimitGuard's own doc comment.
 */
@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    UserRepository,
    SessionRepository,
    OtpChallengeRepository,
    PasswordService,
    TokenService,
    SessionService,
    OtpService,
    AuthNotifierService,
    LoginThrottleService,
    AuthService,
    AuthGuard,
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
  exports: [AuthGuard, UserRepository],
})
export class IdentityModule {}
