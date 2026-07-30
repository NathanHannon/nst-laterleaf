import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CuratedFeedFetchingService } from './curated-feed-fetching.service';
import { CuratedArticlesService } from './curated-articles.service';
import { FeedFetchingService } from './feed-fetching.service';

/**
 * Mirrors the feed-related cron jobs from
 * lb-laterleaf/src/services/cron-job.service.ts:
 *  - `fetch-curated-feeds` (hourly)
 *  - `cleanup-curated-articles` (daily at 2 AM)
 *  - `fetch-user-rss-feeds` (every 15 minutes)
 *
 * The other cron jobs in the original (metadata backfill, article-chunking
 * backfill, rate-limit cleanup, weekly newsletter) belong to other
 * services/phases and are intentionally NOT ported here — see repo memory.
 */
@Injectable()
export class FeedsCronService {
    private readonly logger = new Logger(FeedsCronService.name);

    constructor(
        private readonly curatedFeedFetchingService: CuratedFeedFetchingService,
        private readonly curatedArticlesService: CuratedArticlesService,
        private readonly feedFetchingService: FeedFetchingService,
    ) { }

    /** Fetches new articles from curated feeds and stores their metadata. */
    @Cron('0 * * * *', { name: 'fetch-curated-feeds' })
    async fetchAndStoreCuratedArticles(): Promise<void> {
        const feedItems = await this.curatedFeedFetchingService.fetchAllFeeds();
        let newArticlesCount = 0;

        for (const item of feedItems) {
            try {
                // NOTE: `feedId` is deliberately NOT set here, matching a quirk in
                // the original lb-laterleaf CronJobService.fetchAndStoreCuratedArticles
                // (it never persists FeedItem.feedId onto the CuratedArticle row) —
                // preserved as-is rather than "fixed".
                await this.curatedArticlesService.create({
                    url: item.link,
                    title: item.title,
                    contentHtml: item.contentHtml,
                    description: item.description,
                    author: item.author,
                    imageUrl: item.imageUrl,
                });
                newArticlesCount++;
            } catch (error) {
                const code = (error as { code?: string }).code;
                if (code !== '23505') {
                    // Ignore duplicate URL errors
                    this.logger.warn(`Could not save curated article: ${item.link}`, (error as Error).message);
                }
            }
        }
        this.logger.log(`Stored ${newArticlesCount} new curated articles.`);
    }

    /** Deletes curated articles older than 7 days. */
    @Cron('0 2 * * *', { name: 'cleanup-curated-articles' })
    async cleanupOldCuratedArticles(): Promise<void> {
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        const deletedCount = await this.curatedArticlesService.deleteFetchedBefore(sevenDaysAgo);
        this.logger.log(`Deleted ${deletedCount} old curated articles.`);
    }

    /** Fetches new articles for all users' personally-subscribed RSS feeds. */
    @Cron('*/15 * * * *', { name: 'fetch-user-rss-feeds' })
    async fetchUserFeeds(): Promise<void> {
        await this.feedFetchingService.fetchAllFeeds();
    }
}
