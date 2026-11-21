import { timingSafeEqual } from 'crypto';
import { BadRequestException, Controller, Get, HttpCode, HttpStatus, Logger, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { ClerkAuthGuard } from '../auth/guards/clerk-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { ClerkUserProfile } from '../auth/interfaces/clerk-user-profile.interface';
import { UsersService } from '../users/users.service';

interface RevenueCatEvent {
    environment: 'SANDBOX' | 'PRODUCTION';
    event: {
        app_user_id: string;
        type: string;
        subscriber: any;
    };
}

/**
 * RevenueCat subscription webhook (auth via a static shared-secret header,
 * not a signature scheme) plus the authenticated customer-portal endpoint.
 * Kept as a single controller (no `@Controller('webhooks')` prefix) so the
 * route paths can match the originals exactly: `/webhooks/revenuecat` and
 * `/portal`.
 */
@Controller()
export class RevenuecatWebhookController {
    private readonly logger = new Logger(RevenuecatWebhookController.name);
    private readonly expectedAuthHeader: string;
    private readonly rcApiSecret: string;

    constructor(private readonly usersService: UsersService) {
        this.expectedAuthHeader = process.env.REVENUECAT_WEBHOOK_AUTH_HEADER ?? '';
        this.rcApiSecret = process.env.REVENUECAT_SECRET_API_KEY ?? '';
        if (!this.expectedAuthHeader || !this.rcApiSecret) {
            throw new Error('RevenueCat secrets are not set in environment variables.');
        }
    }

    private isValidAuthHeader(received: string | undefined): boolean {
        if (!received) return false;
        const a = Buffer.from(received);
        const b = Buffer.from(this.expectedAuthHeader);
        return a.length === b.length && timingSafeEqual(a, b);
    }

    @Post('webhooks/revenuecat')
    @HttpCode(HttpStatus.OK)
    async handleRevenueCatWebhooks(@Req() req: Request): Promise<string> {
        const receivedAuthHeader = req.headers['authorization'];
        if (!this.isValidAuthHeader(receivedAuthHeader)) {
            this.logger.warn('Rejected unauthorized RevenueCat webhook request.');
            throw new UnauthorizedException('Unauthorized webhook request.');
        }

        const payload = req.body as RevenueCatEvent | undefined;
        if (!payload?.event?.app_user_id) {
            throw new BadRequestException('Invalid RevenueCat webhook payload.');
        }

        const startTime = Date.now();
        this.logger.log(`Webhook received: ${payload.event.type} (${payload.environment})`);

        try {
            const clerkId = payload.event.app_user_id;

            let subscriber = payload.event.subscriber;

            if (!subscriber) {
                const apiBaseUrl =
                    payload.environment === 'SANDBOX'
                        ? 'https://api-sandbox.revenuecat.com'
                        : 'https://api.revenuecat.com';

                const rcResponse = await fetch(
                    `${apiBaseUrl}/v2/subscribers/${encodeURIComponent(clerkId)}`,
                    {
                        headers: {
                            Authorization: 'Bearer ' + this.rcApiSecret,
                        },
                    },
                );

                if (!rcResponse.ok) {
                    const errorBody = await rcResponse.text();
                    if (rcResponse.status === 404) {
                        console.warn(
                            `[WARN] Subscriber with app_user_id '${clerkId}' not found in RevenueCat ${payload.environment}. Ignoring event.`,
                        );
                        return 'Subscriber not found, ignoring.';
                    }
                    throw new Error(`RevenueCat API Error ${rcResponse.status}: ${errorBody}`);
                }
                const data = await rcResponse.json();
                subscriber = data.subscriber;
            }

            if (!subscriber) {
                throw new Error('Could not retrieve subscriber object from payload or API.');
            }
            console.log(`[3/5] \u2705 Successfully processed subscriber info.`);

            const proEntitlementId = process.env.REVENUECAT_PRO_ENTITLEMENT_ID ?? 'pro_access';
            const proEntitlement = subscriber.entitlements[proEntitlementId];

            const hasProAccess =
                proEntitlement &&
                (proEntitlement.expires_date === null || new Date(proEntitlement.expires_date) > new Date());

            console.log(`[4/5] \uD83D\uDCDD Updating user in database. isPro status: ${hasProAccess}`);
            await this.usersService.updateAll({ isPro: hasProAccess }, { clerkId });
            console.log(`[4/5] \u2705 Database updated for user: ${clerkId}`);

            const duration = Date.now() - startTime;
            console.log(`[5/5] \u2705 Webhook processed successfully in ${duration}ms.`);
            return 'Webhook processed successfully.';
        } catch (err) {
            const error = err as Error;
            const duration = Date.now() - startTime;
            console.error(`[FAIL] \u274C Error after ${duration}ms:`, error.message);
            throw new BadRequestException(`Webhook processing failed: ${error.message}`);
        }
    }

    @UseGuards(ClerkAuthGuard)
    @Get('portal')
    async createPortalSession(@CurrentUser() user: ClerkUserProfile): Promise<{ url: string }> {
        const clerkId = user.clerkId;

        // NOTE: The management URL API does not have a separate sandbox endpoint.
        // RevenueCat automatically directs the user to the correct environment
        // (sandbox/production) based on their most recent purchase history.
        const response = await fetch(
            'https://api.revenuecat.com/v2/subscribers/' + clerkId + '/management/url',
            {
                method: 'POST',
                headers: {
                    Authorization: 'Bearer ' + this.rcApiSecret,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ return_url: process.env.FRONTEND_URL }),
            },
        );

        if (!response.ok) {
            console.error('Failed to create RevenueCat portal session:', await response.text());
            throw new Error('Could not create customer portal session.');
        }

        const data = await response.json();
        return { url: data.url };
    }
}
