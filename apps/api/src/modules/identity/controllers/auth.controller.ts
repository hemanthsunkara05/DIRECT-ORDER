import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { User } from '@prisma/client';
import type { Env } from '../../../platform/config/env.schema.js';
import { APP_CONFIG } from '../../../platform/config/config.module.js';
import { UnauthenticatedError, ValidationError } from '../../../platform/errors/app-error.js';
import { RateLimit } from '../../../platform/rate-limit/rate-limit.decorator.js';
import { ok } from '../../../platform/http/response-envelope.js';
import { hashIp } from '../../../platform/security/hash-ip.js';
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from '../auth.constants.js';
import { AuthService } from '../services/auth.service.js';
import type { SessionContext } from '../services/session.service.js';
import { AuthGuard } from '../guards/auth.guard.js';
import { CurrentUser } from '../decorators/current-user.decorator.js';
import { RegisterDto } from '../dto/register.dto.js';
import { LoginDto } from '../dto/login.dto.js';
import { PasswordForgotDto } from '../dto/password-forgot.dto.js';
import { PasswordResetDto } from '../dto/password-reset.dto.js';
import { OtpRequestDto } from '../dto/otp-request.dto.js';
import { OtpVerifyDto } from '../dto/otp-verify.dto.js';

const DAY_SECONDS = 86_400;

/**
 * Thin HTTP translation layer over AuthService (docs/04-api-specification.md
 * §8.2). Every handler: parse with Zod, call the service, translate the
 * service's discriminated-union result into an HTTP response — no
 * business logic lives here.
 *
 * Deliberately NOT implemented in this phase (see AuthService's doc
 * comment and the Phase 3 report): `/auth/mfa/verify` (admin MFA is
 * Phase 13) and `/auth/invitations/accept` (staff invitations are
 * Phase 5) — both require entities this phase does not yet create.
 */
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly env: Env,
  ) {}

  @Post('register')
  @RateLimit({ limit: 5, windowSeconds: 3600 })
  @HttpCode(200)
  async register(@Body() body: unknown) {
    const input = RegisterDto.parse(body);
    await this.auth.register(input);
    return ok({
      message: 'If this email is not already registered, a verification code has been sent.',
    });
  }

  @Post('login')
  @RateLimit({ limit: 10, windowSeconds: 900 })
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = LoginDto.parse(body);
    const result = await this.auth.login(input.email, input.password, this.buildContext(req));

    if (result.outcome !== 'SUCCESS') {
      // Deliberately identical for wrong password, unknown account,
      // locked account, and disabled account — docs/09-security.md
      // §15.2, "generic failure message".
      throw new UnauthenticatedError('Invalid email or password.');
    }

    this.setSessionCookies(reply, result.accessToken, result.issued.refreshToken);
    return ok(this.toPublicUser(result.user));
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const refreshToken = req.cookies?.[REFRESH_TOKEN_COOKIE];
    if (refreshToken) {
      await this.auth.logout(refreshToken);
    }
    this.clearSessionCookies(reply);
    return ok({ status: 'ok' });
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const refreshToken = req.cookies?.[REFRESH_TOKEN_COOKIE];
    if (!refreshToken) {
      throw new UnauthenticatedError();
    }

    const result = await this.auth.refresh(refreshToken, this.buildContext(req));

    if (result.outcome !== 'ROTATED') {
      // Whatever the reason (invalid, expired, or reuse detected), the
      // client's cookies are now dead — clear them so it doesn't keep
      // retrying with a token that will never work again.
      this.clearSessionCookies(reply);
      throw new UnauthenticatedError();
    }

    this.setSessionCookies(reply, result.accessToken, result.issued.refreshToken);
    return ok({ status: 'ok' });
  }

  @Post('password/forgot')
  @RateLimit({ limit: 5, windowSeconds: 3600 })
  @HttpCode(200)
  async forgotPassword(@Body() body: unknown) {
    const input = PasswordForgotDto.parse(body);
    await this.auth.forgotPassword(input.email);
    return ok({ message: 'If this email is registered, a password reset link has been sent.' });
  }

  @Post('password/reset')
  @HttpCode(200)
  async resetPassword(@Body() body: unknown) {
    const input = PasswordResetDto.parse(body);
    const result = await this.auth.resetPassword(input.token, input.newPassword);
    if (result !== 'RESET') {
      throw new ValidationError('This reset link is invalid or has expired.');
    }
    return ok({ status: 'ok' });
  }

  @Post('otp/request')
  @RateLimit({
    limit: 5,
    windowSeconds: 3600,
    keyBy: (req) => (req.body as { identifier?: string } | undefined)?.identifier,
  })
  @HttpCode(200)
  async requestOtp(@Body() body: unknown) {
    const input = OtpRequestDto.parse(body);
    await this.auth.requestVerification(input.identifier, input.purpose);
    return ok({ message: 'If applicable, a verification code has been sent.' });
  }

  @Post('otp/verify')
  @HttpCode(200)
  async verifyOtp(@Body() body: unknown) {
    const input = OtpVerifyDto.parse(body);
    const result = await this.auth.verify(input.identifier, input.purpose, input.code);
    if (result !== 'VERIFIED') {
      throw new ValidationError(
        'The verification code is invalid, expired, or has been used too many times.',
      );
    }
    return ok({ status: 'ok' });
  }

  @Get('me')
  @UseGuards(AuthGuard)
  @HttpCode(200)
  me(@CurrentUser() user: User) {
    return ok(this.toPublicUser(user));
  }

  private setSessionCookies(reply: FastifyReply, accessToken: string, refreshToken: string): void {
    const secure = this.env.APP_ENV !== 'local';
    reply.setCookie(ACCESS_TOKEN_COOKIE, accessToken, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/',
      domain: this.env.COOKIE_DOMAIN,
      maxAge: this.env.JWT_ACCESS_TTL_SECONDS,
    });
    reply.setCookie(REFRESH_TOKEN_COOKIE, refreshToken, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/',
      domain: this.env.COOKIE_DOMAIN,
      maxAge: this.env.REFRESH_TOKEN_TTL_DAYS * DAY_SECONDS,
    });
  }

  private clearSessionCookies(reply: FastifyReply): void {
    reply.clearCookie(ACCESS_TOKEN_COOKIE, { path: '/', domain: this.env.COOKIE_DOMAIN });
    reply.clearCookie(REFRESH_TOKEN_COOKIE, { path: '/', domain: this.env.COOKIE_DOMAIN });
  }

  private buildContext(req: FastifyRequest): SessionContext {
    return {
      userAgent: req.headers['user-agent'],
      ipHash: hashIp(this.env.JWT_SECRET, req.ip),
    };
  }

  /**
   * The field allowlist behind the "GET /auth/me never returns a
   * password hash, token, or secret" acceptance criterion — everything
   * this method does NOT copy from `user` (passwordHash, mfaSecret, ...)
   * is structurally absent from the response, not merely unmentioned.
   */
  private toPublicUser(user: User) {
    return {
      id: user.id,
      email: user.email,
      phone: user.phone,
      fullName: user.fullName,
      status: user.status,
      emailVerified: user.emailVerifiedAt !== null,
      phoneVerified: user.phoneVerifiedAt !== null,
      createdAt: user.createdAt,
    };
  }
}
