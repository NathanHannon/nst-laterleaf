import { Body, Controller, ForbiddenException, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClerkAuthGuard } from '../auth/guards/clerk-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { ClerkUserProfile } from '../auth/interfaces/clerk-user-profile.interface';
import { CuratedArticlesService } from './curated-articles.service';
import { CuratedArticle } from './entities/curated-article.entity';

/**
 * Mirrors lb-laterleaf/src/controllers/curated-feed-curated-article.controller.ts
 * (the LoopBack `hasMany` nested-resource controller). Admin-only listing
 * and creation of `CuratedArticle`s scoped to a specific `CuratedFeed`.
 *
 * NOTE: the original also exposed bulk `PATCH`/`DELETE` with an arbitrary
 * `where` filter scoped within the feed's articles. No frontend consumer
 * uses these (curated articles are populated by the fetch cron, not
 * manually edited in bulk), so they are not reproduced here.
 */
@UseGuards(ClerkAuthGuard)
@Controller('curated-feeds/:id/curated-articles')
export class CuratedFeedCuratedArticleController {
    constructor(
        private readonly curatedArticlesService: CuratedArticlesService,
        private readonly configService: ConfigService,
    ) { }

    private requireAdmin(currentUser: ClerkUserProfile): void {
        const adminClerkIds = this.configService.get<string>('ADMIN_CLERK_IDS')?.split(',');
        if (adminClerkIds?.includes(currentUser.clerkId)) {
            return;
        }

        const role = currentUser.publicMetadata?.role;
        if (role !== 'admin' && role !== 'moderator') {
            throw new ForbiddenException('Admin access required');
        }
    }

    @Get()
    async find(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Param('id') feedId: string,
    ): Promise<CuratedArticle[]> {
        this.requireAdmin(currentUser);
        return this.curatedArticlesService.findByFeedId(feedId);
    }

    @Post()
    async create(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Param('id') feedId: string,
        @Body() body: Omit<CuratedArticle, 'id' | 'feedId'>,
    ): Promise<CuratedArticle> {
        this.requireAdmin(currentUser);
        return this.curatedArticlesService.create({ ...body, feedId });
    }
}
