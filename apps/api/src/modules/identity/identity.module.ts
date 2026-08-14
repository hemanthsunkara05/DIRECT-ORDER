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
import { OptionalAuthService } from './services/optional-auth.service.js';
import { AuthNotifierService } from './services/auth-notifier.service.js';
import { LoginThrottleService } from './services/login-throttle.service.js';
import { AuthService } from './services/auth.service.js';
import { TotpService } from './services/totp.service.js';
import { MfaService } from './services/mfa.service.js';
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
    OptionalAuthService,
    AuthNotifierService,
    LoginThrottleService,
    AuthService,
    TotpService,
    MfaService,
    AuthGuard,
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
  // TokenService and SessionRepository are exported alongside AuthGuard
  // (not just AuthGuard itself) because AuthGuard depends on both —
  // a module that imports IdentityModule purely to use `@UseGuards(AuthGuard)`
  // needs AuthGuard's full constructor dependency chain resolvable, not
  // just the guard class itself. OtpService/SessionService/
  // OptionalAuthService (Phase 16) are exported for CustomerAuthModule,
  // which assembles the exact same request-a-code/verify-a-
  // code/issue-a-session flow AuthService uses for staff, just for
  // customers — reusing these pieces directly rather than duplicating
  // OTP or session logic a second time.
  exports: [
    AuthGuard,
    UserRepository,
    TokenService,
    SessionRepository,
    OtpService,
    SessionService,
    OptionalAuthService,
    AuthNotifierService,
  ],
})
export class IdentityModule {}
