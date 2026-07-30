import {
    Body,
    ConflictException,
    Controller,
    Delete,
    ForbiddenException,
    Get,
    Param,
    Post,
    Query,
    UnauthorizedException,
    UseGuards,
} from '@nestjs/common';
import { ClerkAuthGuard } from '../auth/guards/clerk-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { ClerkUserProfile } from '../auth/interfaces/clerk-user-profile.interface';
import { UsersService } from '../users/users.service';
import { FeedsService } from './feeds.service';
import { FeedArticlesService } from './feed-articles.service';
import { UserFeedsService } from './user-feeds.service';
import { FeedFetchingService } from './feed-fetching.service';
import { UserFeed } from './entities/user-feed.entity';

/**
 * Ports lb-laterleaf/src/controllers/user-feed.controller.ts. Manages a
 * user's personal RSS feed subscriptions (`GET/POST /users/me/feeds`,
 * `DELETE /users/me/feeds/:id`) and their cached articles
 * (`GET /users/me/feed-articles`).
 *
 * NOTE: no TypeORM relations between UserFeed/Feed, so the `feed` details
 * that LB's `include: [{relation: 'feed'}]` would have attached are joined
 * manually here via `FeedsService`.
 */
@UseGuards(ClerkAuthGuard)
@Controller('users/me')
export class UserFeedController {
    constructor(
        private readonly usersService: UsersService,
        private readonly feedsService: FeedsService,
        private readonly feedArticlesService: FeedArticlesService,
        private readonly userFeedsService: UserFeedsService,
        private readonly feedFetchingService: FeedFetchingService,
    ) { }

    @Get('feeds')
    async findMine(
        @CurrentUser() currentUser: ClerkUserProfile,
    ): Promise<(UserFeed & { feed?: Awaited<ReturnType<FeedsService['findById']>> })[]> {
        const user = await this.usersService.findByClerkId(currentUser.clerkId);
        if (!user?.id) {
            throw new UnauthorizedException('User not found');
        }

        const userFeeds = await this.userFeedsService.findAllForUser(user.id);
        const feeds = await Promise.all(
            userFeeds.map((uf) => this.feedsService.findById(uf.feedId)),
        );

        return userFeeds.map((uf, index) => ({ ...uf, feed: feeds[index] ?? undefined }));
    }

    @Post('feeds')
    async create(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Body() feedRequest: { url: string; titleOverride?: string },
    ): Promise<UserFeed & { feed?: Awaited<ReturnType<FeedsService['findById']>> }> {
        const user = await this.usersService.findByClerkId(currentUser.clerkId);
        if (!user?.id) {
            throw new UnauthorizedException('User not found');
        }

        // 1. Check if the exact feed URL already exists in the Feed table
        let feed = await this.feedsService.findByUrl(feedRequest.url);

        if (!feed) {
            // Create new feed definition. Ideally we'd fetch and parse it here
            // to get title/description; for now, save a placeholder title
            // until the background job (or the immediate fetch below) updates it.
            feed = await this.feedsService.create({
                url: feedRequest.url,
                title: feedRequest.url,
            });
        }

        // 2. Check if user is already subscribed
        const existingSub = await this.userFeedsService.findByUserAndFeed(user.id, feed.id);
        if (existingSub) {
            throw new ConflictException('You are already subscribed to this feed.');
        }

        // 3. Create junction
        const userFeed = await this.userFeedsService.create({
            userId: user.id,
            feedId: feed.id,
            titleOverride: feedRequest.titleOverride,
        });

        // 4. Immediately fetch articles for this feed so the user doesn't have to wait for the cron job
        this.feedFetchingService
            .fetchSingleFeed(feed)
            .then((count) => {
                if (count > 0) {
                    console.log(`[UserFeedController] Immediate fetch for "${feed.url}" added ${count} articles`);
                }
            })
            .catch((err) => {
                console.warn(`[UserFeedController] Immediate fetch failed for "${feed.url}": ${err.message}`);
            });

        return { ...userFeed, feed };
    }

    @Delete('feeds/:id')
    async deleteById(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Param('id') id: string,
    ): Promise<void> {
        const user = await this.usersService.findByClerkId(currentUser.clerkId);
        if (!user?.id) {
            throw new UnauthorizedException('User not found');
        }

        const userFeed = await this.userFeedsService.findById(id);
        if (!userFeed) {
            throw new UnauthorizedException('Feed subscription not found');
        }
        if (userFeed.userId !== user.id) {
            throw new ForbiddenException("Cannot delete another user's feed subscription");
        }
        await this.userFeedsService.deleteById(id);
    }

    @Get('feed-articles')
    async findMyFeedArticles(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Query('limit') limit?: string,
    ): Promise<
        {
            id: string;
            title: string;
            url: string;
            author?: string;
            publishedAt: Date;
            description?: string;
            contentHtml?: string;
            imageUrl?: string;
            feedId?: string;
            feedTitle: string;
            feedUrl: string;
        }[]
    > {
        const user = await this.usersService.findByClerkId(currentUser.clerkId);
        if (!user?.id) {
            throw new UnauthorizedException('User not found');
        }
        const parsedLimit = limit ? parseInt(limit, 10) : 50;

        // 1. Fetch user's feed subscriptions
        const myFeeds = await this.userFeedsService.findAllForUser(user.id);
        if (myFeeds.length === 0) {
            return [];
        }

        const feedIds = myFeeds.map((uf) => uf.feedId).filter((id): id is string => Boolean(id));
        const feeds = await Promise.all(feedIds.map((id) => this.feedsService.findById(id)));

        const feedMap = new Map<string, { titleOverride?: string; feedTitle?: string; feedUrl?: string }>();
        myFeeds.forEach((uf, index) => {
            if (uf.feedId) {
                const feed = feeds[index];
                feedMap.set(uf.feedId, {
                    titleOverride: uf.titleOverride,
                    feedTitle: feed?.title,
                    feedUrl: feed?.url,
                });
            }
        });

        // 2. Fetch directly from pre-cached db
        const articles = await this.feedArticlesService.findByFeedIds(feedIds, parsedLimit);

        // 3. Map back to frontend expected structure
        return articles.map((article) => {
            const feedInfo = feedMap.get(article.feedId ?? '') ?? {};
            return {
                id: article.id,
                title: article.title,
                url: article.url,
                author: article.author,
                publishedAt: article.publishedAt,
                description: article.description,
                contentHtml: article.contentHtml,
                imageUrl: article.imageUrl,
                feedId: article.feedId,
                feedTitle: feedInfo.titleOverride || feedInfo.feedTitle || 'Unknown Feed',
                feedUrl: feedInfo.feedUrl || '',
            };
        });
    }
}
