import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import * as jwksRsa from 'jwks-rsa';
import { ClerkUserProfile } from '../interfaces/clerk-user-profile.interface';

/**
 * Passport integration. Verifies Clerk-issued RS256 JWTs against Clerk's
 * JWKS endpoint and builds a ClerkUserProfile for `req.user`.
 */
@Injectable()
export class ClerkStrategy extends PassportStrategy(Strategy, 'clerk') {
    constructor(configService: ConfigService) {
        const jwksUri = configService.get<string>('CLERK_JWKS_URL');
        if (!jwksUri) {
            throw new Error('CLERK_JWKS_URL environment variable not set');
        }

        super({
            jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
            algorithms: ['RS256'],
            secretOrKeyProvider: jwksRsa.passportJwtSecret({
                cache: true,
                rateLimit: true,
                jwksRequestsPerMinute: 5,
                jwksUri,
            }),
        });
    }

    validate(payload: Record<string, any>): ClerkUserProfile {
        const publicMetadata =
            payload.public_metadata ??
            payload.publicMetadata ??
            payload.metadata?.public ??
            payload.user_metadata?.public ??
            undefined;

        // Log user plan tier information occasionally (~1% of requests) to
        // mirror the noise-reduction behavior of the original strategy.
        if (Math.random() < 0.01) {
            const plaField = payload.pla ?? 'u:free_user';
            const features = publicMetadata?.features ?? [];
            const role = publicMetadata?.role;

            let planTier = 'free';
            let accessMethod = 'plan-based';
            if (features.includes('research_grade_ai')) {
                planTier = 'pro';
                accessMethod = 'feature flag';
            } else if (role === 'admin') {
                planTier = 'pro (admin)';
                accessMethod = 'admin override';
            } else if (
                plaField.includes('pro') ||
                plaField.includes('max') ||
                plaField.includes('premium')
            ) {
                planTier = 'pro';
                accessMethod = 'plan-based';
            }

            console.log('🔑 User Authentication:', {
                clerkId: payload.sub?.substring(0, 8) + '...',
                planTier,
                accessMethod,
                role: role ?? 'none',
                timestamp: new Date().toISOString(),
            });
        }

        return {
            id: payload.sub,
            clerkId: payload.sub,
            publicMetadata,
            rawToken: payload,
        };
    }
}
