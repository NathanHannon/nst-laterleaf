import { Body, Controller, Delete, ForbiddenException, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ClerkAuthGuard } from '../auth/guards/clerk-auth.guard';
import type { ClerkUserProfile } from '../auth/interfaces/clerk-user-profile.interface';
import { ArticlesService } from '../articles/articles.service';
import { BlockedDomainsService } from '../content-moderation/blocked-domains.service';
import type { BlockedDomain } from '../content-moderation/entities/blocked-domain.entity';
import { JobQueueService } from '../jobs/job-queue.service';
import { UsersService } from '../users/users.service';
import { CreateBlockedDomainDto } from './dto/create-blocked-domain.dto';

@UseGuards(ClerkAuthGuard)
@Controller('admin')
export class AdminController {
    constructor(
        private readonly configService: ConfigService,
        private readonly usersService: UsersService,
        private readonly articlesService: ArticlesService,
        private readonly blockedDomainsService: BlockedDomainsService,
        private readonly jobQueueService: JobQueueService,
    ) { }

    private isAdmin(currentUser: ClerkUserProfile): boolean {
        return this.canSelectAiProvider(currentUser) || currentUser.publicMetadata?.role === 'moderator';
    }

    private canSelectAiProvider(currentUser: ClerkUserProfile): boolean {
        const adminClerkIds = this.configService
            .get<string>('ADMIN_CLERK_IDS')
            ?.split(',')
            .map((id) => id.trim())
            .filter(Boolean);
        const role = currentUser.publicMetadata?.role;
        return Boolean(adminClerkIds?.includes(currentUser.clerkId) || role === 'admin');
    }

    private requireAdmin(currentUser: ClerkUserProfile): void {
        if (!this.isAdmin(currentUser)) {
            throw new ForbiddenException('Admin access required');
        }
    }

    @Get('check-access')
    checkAccess(@CurrentUser() currentUser: ClerkUserProfile) {
        return {
            isAdmin: this.isAdmin(currentUser),
            canSelectAiProvider: this.canSelectAiProvider(currentUser),
            clerkId: currentUser.clerkId,
            metadata: currentUser.publicMetadata,
        };
    }

    @Get('blocked-domains')
    getBlockedDomains(@CurrentUser() currentUser: ClerkUserProfile): Promise<BlockedDomain[]> {
        this.requireAdmin(currentUser);
        return this.blockedDomainsService.findAll();
    }

    @Post('blocked-domains')
    createBlockedDomain(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Body() body: CreateBlockedDomainDto,
    ): Promise<BlockedDomain> {
        this.requireAdmin(currentUser);
        return this.blockedDomainsService.create({
            domain: body.domain.trim().toLowerCase(),
            reason: body.reason,
            notes: body.notes?.trim() || undefined,
        });
    }

    @Delete('blocked-domains/:domain')
    async deleteBlockedDomain(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Param('domain') domain: string,
    ): Promise<void> {
        this.requireAdmin(currentUser);
        await this.blockedDomainsService.deleteByDomain(domain);
    }

    @Get('users')
    async getUsers(@CurrentUser() currentUser: ClerkUserProfile) {
        this.requireAdmin(currentUser);
        const users = await this.usersService.find({ order: { createdAt: 'DESC' } });
        return users.map((user) => ({
            id: user.id,
            clerkId: user.clerkId,
            hasProAccess: user.isPro,
            createdAt: user.createdAt,
        }));
    }

    @Get('stats')
    async getStats(@CurrentUser() currentUser: ClerkUserProfile) {
        this.requireAdmin(currentUser);

        const [blockedDomains, totalUsers, proUsers, totalArticles, queues] = await Promise.all([
            this.blockedDomainsService.findAll(),
            this.usersService.count(),
            this.usersService.count({ isPro: true }),
            this.articlesService.count(),
            this.jobQueueService.getQueueStats(),
        ]);

        const blockedByReason = Object.entries(
            blockedDomains.reduce<Record<string, number>>((counts, blockedDomain) => {
                counts[blockedDomain.reason] = (counts[blockedDomain.reason] || 0) + 1;
                return counts;
            }, {}),
        ).map(([reason, count]) => ({ reason, count }));

        return {
            blockedDomains: blockedDomains.length,
            blockedByReason,
            users: { total: totalUsers, pro: proUsers },
            articles: { total: totalArticles },
            queues,
        };
    }
}