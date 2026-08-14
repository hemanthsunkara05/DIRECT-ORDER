import { Body, Controller, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { User } from '@prisma/client';
import type { Env } from '../../../platform/config/env.schema.js';
import { APP_CONFIG } from '../../../platform/config/config.module.js';
import { ValidationError } from '../../../platform/errors/app-error.js';
import { RateLimit } from '../../../platform/rate-limit/rate-limit.decorator.js';
import { ok } from '../../../platform/http/response-envelope.js';
import { hashIp } from '../../../platform/security/hash-ip.js';
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from '../../identity/auth.constants.js';
import type { SessionContext } from '../../identity/services/session.service.js';
import { CustomerAuthService } from '../services/customer-auth.service.js';
import { CustomerOtpRequestDto } from '../dto/customer-otp-request.dto.js';
import { CustomerOtpVerifyDto } from '../dto/customer-otp-verify.dto.js';

const DAY_SECONDS = 86_400;

/**
 * `POST /auth/customer/otp/{request,verify}` — AMB-2's phone-OTP
 * customer login. Sets the SAME `do_access_token`/`do_refresh_token`
 * cookies `AuthController` sets for staff logins: `AuthGuard` resolves
 * a `User` regardless of which kind of principal it backs, so a
 * customer session works with every existing authenticated-route
 * mechanism (cookies, refresh rotation, logout) without any of them
 * needing a customer-specific branch — only routes that additionally
 * require a `Customer` profile (`CustomerAccountGuard`) tell the two
 * kinds of principal apart.
 */
@Controller('auth/customer')
export class CustomerAuthController {
  constructor(
    @Inject(CustomerAuthService) private readonly customerAuth: CustomerAuthService,
    @Inject(APP_CONFIG) private readonly env: Env,
  ) {}

  @Post('otp/request')
  @RateLimit({
    limit: 5,
    windowSeconds: 3600,
    keyBy: (req) => (req.body as { phone?: string } | undefined)?.phone,
  })
  @HttpCode(200)
  async requestOtp(@Body() body: unknown) {
    const input = CustomerOtpRequestDto.parse(body);
    await this.customerAuth.requestOtp(input.phone);
    return ok({ message: 'If applicable, a verification code has been sent.' });
  }

  @Post('otp/verify')
  @RateLimit({
    limit: 10,
    windowSeconds: 900,
    keyBy: (req) => (req.body as { phone?: string } | undefined)?.phone,
  })
  @HttpCode(200)
  async verifyOtp(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = CustomerOtpVerifyDto.parse(body);
    const result = await this.customerAuth.verifyOtp(
      input.phone,
      input.code,
      { fullName: input.fullName, referralCode: input.referralCode },
      this.buildContext(req),
    );

    if (result.outcome !== 'VERIFIED') {
      throw new ValidationError(
        'The verification code is invalid, expired, or has been used too many times.',
      );
    }

    this.setSessionCookies(reply, result.accessToken, result.issued.refreshToken);
    return ok({ ...this.toPublicUser(result.user), referralApplied: result.referralApplied });
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

  private buildContext(req: FastifyRequest): SessionContext {
    return {
      userAgent: req.headers['user-agent'],
      ipHash: hashIp(this.env.JWT_SECRET, req.ip),
    };
  }

  private toPublicUser(user: User) {
    return {
      id: user.id,
      phone: user.phone,
      fullName: user.fullName,
      phoneVerified: user.phoneVerifiedAt !== null,
      createdAt: user.createdAt,
    };
  }
}
