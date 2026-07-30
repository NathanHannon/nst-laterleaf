import { BadRequestException, Controller, HttpCode, HttpStatus, Post, Req, UnauthorizedException } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { Webhook } from 'svix';
import { UsersService } from '../users/users.service';
import { CollectionsService } from '../collections/collections.service';
import { ArticleCollectionsService } from '../collections/article-collections.service';
import { UserArticlesService } from '../articles/user-articles.service';
import { UserArticleTagsService } from '../tags/user-article-tags.service';
import type { SubscriptionStatus } from '../users/entities/user.entity';

type ClerkBillingPlan = {
    id?: string | null;
    slug?: string | null;
    name?: string | null;
};

type ClerkBillingSubscriptionItem = {
    payerId?: string;
    payer_id?: string;
    payer?: { user_id?: string };
    status?: string;
    periodEnd?: number | null;
    period_end?: number | null;
    planId?: string | null;
    plan_id?: string | null;
    plan?: ClerkBillingPlan | null;
};

/**
 * Ports lb-laterleaf/src/controllers/clerk.controller.ts (billing +
 * user-lifecycle webhooks). Not gated by ClerkAuthGuard — Clerk webhook
 * requests carry svix-* signature headers (verified below), not a user JWT.
 *
 * NOTE: requires `NestFactory.create(AppModule, { rawBody: true })` in
 * main.ts so `req.rawBody` (the exact bytes Clerk signed) is available —
 * svix signature verification fails if it's re-serialized JSON instead of
 * the original raw body, which is why lb-laterleaf used a custom
 * `x-parser: raw` body parser for this one endpoint.
 */
@Controller('webhooks')
export class ClerkWebhookController {
    private readonly webhook: Webhook;

    constructor(
        private readonly usersService: UsersService,
        private readonly collectionsService: CollectionsService,
        private readonly articleCollectionsService: ArticleCollectionsService,
        private readonly userArticlesService: UserArticlesService,
        private readonly userArticleTagsService: UserArticleTagsService,
    ) {
        const webhookSecret = process.env.CLERK_WEBHOOK_SECRET ?? '';
        if (!webhookSecret) {
            throw new Error('CLERK_WEBHOOK_SECRET is not set in environment variables.');
        }
        this.webhook = new Webhook(webhookSecret);
    }

    private parseEnvList(...values: Array<string | undefined>): string[] {
        return values
            .flatMap((value) => (value ?? '').split(','))
            .map((value) => value.trim().toLowerCase())
            .filter(Boolean);
    }

    private getClerkBillingUserId(item: ClerkBillingSubscriptionItem): string | undefined {
        return item.payer?.user_id ?? item.payerId ?? item.payer_id;
    }

    private isConfiguredProPlan(item: ClerkBillingSubscriptionItem): boolean {
        const configuredPlanIds = this.parseEnvList(process.env.CLERK_PRO_PLAN_ID, process.env.CLERK_PRO_PLAN_IDS);
        const configuredPlanSlugs = this.parseEnvList(
            process.env.CLERK_PRO_PLAN_SLUG,
            process.env.CLERK_PRO_PLAN_SLUGS,
        );

        const planId = item.planId ?? item.plan_id ?? item.plan?.id ?? '';
        const planSlug = item.plan?.slug ?? '';

        if (configuredPlanIds.length > 0 || configuredPlanSlugs.length > 0) {
            return configuredPlanIds.includes(planId.toLowerCase()) || configuredPlanSlugs.includes(planSlug.toLowerCase());
        }

        const planFingerprint = `${planId} ${planSlug} ${item.plan?.name ?? ''}`.toLowerCase();
        const inferredProPlan = /(\bpro\b|premium|max|plus)/.test(planFingerprint);

        if (inferredProPlan) {
            console.warn('CLERK_PRO_PLAN_ID/SLUG not configured; inferring Pro plan from Clerk billing payload.', {
                planId,
                planSlug,
                planName: item.plan?.name,
            });
        }

        return inferredProPlan;
    }

    private normalizeBillingStatus(eventType: string, item: ClerkBillingSubscriptionItem): SubscriptionStatus {
        const rawStatus = (item.status ?? '').toLowerCase().replace('pastdue', 'past_due');

        if (rawStatus === 'active' || rawStatus === 'canceled' || rawStatus === 'past_due' || rawStatus === 'unpaid') {
            return rawStatus;
        }

        switch (eventType) {
            case 'subscriptionItem.active':
                return 'active';
            case 'subscriptionItem.canceled':
                return 'canceled';
            case 'subscriptionItem.pastDue':
                return 'past_due';
            default:
                return 'inactive';
        }
    }

    private getPeriodEndDate(item: ClerkBillingSubscriptionItem): Date | undefined {
        const periodEnd = item.periodEnd ?? item.period_end;
        if (!periodEnd) return undefined;
        return new Date(periodEnd);
    }

    private shouldGrantProAccess(status: SubscriptionStatus, expirationDate?: Date): boolean {
        if (status === 'active') return true;
        if (!expirationDate) return false;

        const hasUnexpiredAccess = expirationDate.getTime() > Date.now();
        return hasUnexpiredAccess && (status === 'canceled' || status === 'past_due');
    }

    private async syncBillingSubscriptionItem(eventType: string, item: ClerkBillingSubscriptionItem): Promise<void> {
        const clerkUserId = this.getClerkBillingUserId(item);

        if (!clerkUserId) {
            console.error('Could not find Clerk user ID in subscription item payload.', item);
            return;
        }

        if (!this.isConfiguredProPlan(item)) {
            console.log('Ignoring Clerk billing event for non-Pro plan.', {
                eventType,
                clerkUserId,
                planId: item.planId ?? item.plan_id ?? item.plan?.id,
                planSlug: item.plan?.slug,
                planName: item.plan?.name,
            });
            return;
        }

        const subscriptionStatus = this.normalizeBillingStatus(eventType, item);
        const subscriptionExpiration = this.getPeriodEndDate(item);
        const isPro = this.shouldGrantProAccess(subscriptionStatus, subscriptionExpiration);

        await this.usersService.updateAll(
            { isPro, subscriptionStatus, subscriptionExpiration },
            { clerkId: clerkUserId },
        );

        console.log('Synced Clerk billing subscription item.', {
            eventType,
            clerkUserId,
            subscriptionStatus,
            subscriptionExpiration: subscriptionExpiration?.toISOString(),
            isPro,
            planId: item.planId ?? item.plan_id ?? item.plan?.id,
            planSlug: item.plan?.slug,
        });
    }

    private async handleUserCreated(clerkUser: { id: string }): Promise<void> {
        const existingUser = await this.usersService.findByClerkId(clerkUser.id);

        if (existingUser) {
            console.log(`Duplicate user.created event for Clerk ID: ${clerkUser.id}. Skipping.`);
            return;
        }

        console.log('--> CREATING USER with mapped object:', { clerkId: clerkUser.id });
        const newUser = await this.usersService.create({ clerkId: clerkUser.id, isPro: false });
        console.log(`User created in local DB with Clerk ID: ${clerkUser.id}`);

        if (newUser?.id) {
            await this.collectionsService.create({
                name: 'Archive',
                description: 'A collection for your archived articles.',
                userId: newUser.id,
            });
        }
    }

    private async handleUserDeleted(deletedUser: { id: string; deleted?: boolean }): Promise<void> {
        if (!deletedUser.deleted) return;

        const user = await this.usersService.findByClerkId(deletedUser.id);
        if (!user?.id) {
            console.log(`User not found for deletion with Clerk ID: ${deletedUser.id}`);
            return;
        }

        console.log(`Starting data cleanup for user ${user.id} (Clerk: ${deletedUser.id})`);

        // 1. Clean up UserArticles and their Tags.
        const userArticles = await this.userArticlesService.findAllForUser(user.id);
        const userArticleIds = userArticles.map((ua) => ua.id).filter(Boolean);

        if (userArticleIds.length > 0) {
            await this.userArticleTagsService.deleteByUserArticleIds(userArticleIds);
            await this.userArticlesService.deleteAllForUser(user.id);
            console.log(`Deleted ${userArticles.length} user articles.`);
        }

        // 2. Clean up Collections and their Article links.
        const collections = await this.collectionsService.find({ where: { userId: user.id } });
        const collectionIds = collections.map((c) => c.id).filter(Boolean);

        if (collectionIds.length > 0) {
            await this.articleCollectionsService.deleteByCollectionIds(collectionIds);
            await this.collectionsService.deleteAllForUser(user.id);
            console.log(`Deleted ${collections.length} collections.`);
        }

        // 3. Delete the User.
        await this.usersService.deleteById(user.id);
        console.log(`User deleted from local DB with Clerk ID: ${deletedUser.id}`);
    }

    @Post('clerk')
    @HttpCode(HttpStatus.OK)
    async handleClerkWebhooks(@Req() req: RawBodyRequest<Request>): Promise<string> {
        const rawBody = req.rawBody;
        if (!rawBody) {
            throw new BadRequestException('Missing raw request body.');
        }

        const svixId = req.headers['svix-id'] as string;
        const svixTimestamp = req.headers['svix-timestamp'] as string;
        const svixSignature = req.headers['svix-signature'] as string;

        if (!svixId || !svixTimestamp || !svixSignature) {
            throw new BadRequestException('Missing Svix headers');
        }

        // NOTE: fidelity quirk preserved from lb-laterleaf — the entire
        // verify+process block shares one catch, so a downstream DB error
        // while handling the event also surfaces as a 401 "Webhook
        // verification failed" response, not just actual signature failures.
        try {
            const verifiedPayload = this.webhook.verify(rawBody.toString('utf-8'), {
                'svix-id': svixId,
                'svix-timestamp': svixTimestamp,
                'svix-signature': svixSignature,
            }) as { type: string; data: any };

            const eventType = verifiedPayload.type;
            console.log(`Received and verified Clerk event: ${eventType}`);

            switch (eventType) {
                case 'user.created':
                    await this.handleUserCreated(verifiedPayload.data);
                    break;

                case 'user.updated':
                    // This event is for user profile changes, not subscriptions.
                    // No billing logic needed here.
                    console.log(`User updated event received for Clerk ID: ${verifiedPayload.data.id}`);
                    break;

                case 'user.deleted':
                    await this.handleUserDeleted(verifiedPayload.data);
                    break;

                // --- Billing events ---
                case 'subscriptionItem.created':
                case 'subscriptionItem.active':
                case 'subscriptionItem.updated':
                case 'subscriptionItem.canceled':
                case 'subscriptionItem.ended':
                case 'subscriptionItem.pastDue':
                case 'subscriptionItem.upcoming':
                case 'subscriptionItem.abandoned':
                case 'subscriptionItem.incomplete':
                    await this.syncBillingSubscriptionItem(eventType, verifiedPayload.data as ClerkBillingSubscriptionItem);
                    break;

                case 'subscriptionItem.freeTrialEnding':
                    console.log('Ignoring Clerk free-trial warning event because trial periods are not used.', {
                        clerkUserId: this.getClerkBillingUserId(verifiedPayload.data as ClerkBillingSubscriptionItem),
                        planId:
                            (verifiedPayload.data as ClerkBillingSubscriptionItem).planId ??
                            (verifiedPayload.data as ClerkBillingSubscriptionItem).plan_id,
                        planSlug: (verifiedPayload.data as ClerkBillingSubscriptionItem).plan?.slug,
                    });
                    break;

                default:
                    console.log(`Unhandled event type: ${eventType}`);
                    break;
            }

            return 'Webhook processed successfully.';
        } catch (err) {
            const error = err as Error;
            console.error('Error verifying webhook:', error.message);
            throw new UnauthorizedException(`Webhook verification failed: ${error.message}`);
        }
    }
}
