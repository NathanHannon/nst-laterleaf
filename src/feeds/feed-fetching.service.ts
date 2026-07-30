import { Injectable, Logger } from '@nestjs/common';
import Parser from 'rss-parser';
import { ContentExtractionService } from '../content-extraction/content-extraction.service';
import { FeedsService } from './feeds.service';
import { FeedArticlesService } from './feed-articles.service';
import { Feed } from './entities/feed.entity';

/**
 * Mirrors lb-laterleaf/src/services/feed-fetching.service.ts. Fetches and
 * caches articles from a user's personally-subscribed RSS `Feed`s (as
 * opposed to `CuratedFeedFetchingService`, which handles admin-curated
 * Discover-page feeds).
 */
@Injectable()
export class FeedFetchingService {
    private readonly logger = new Logger(FeedFetchingService.name);
    private readonly rssParser: Parser;

    constructor(
        private readonly feedsService: FeedsService,
        private readonly feedArticlesService: FeedArticlesService,
        private readonly contentExtractionService: ContentExtractionService,
    ) {
        this.rssParser = new Parser({
            customFields: {
                item: [
                    ['media:content', 'mediaContent'],
                    ['content:encoded', 'contentEncoded'],
                ],
            },
        });
    }

    async fetchAllFeeds(): Promise<void> {
        const feeds = await this.feedsService.find();
        this.logger.log(`Starting background fetch for ${feeds.length} feeds`);

        let articlesAdded = 0;
        for (const feed of feeds) {
            articlesAdded += await this.fetchSingleFeed(feed);
        }

        this.logger.log(`Completed background fetch. Added ${articlesAdded} new articles.`);
    }

    async fetchSingleFeed(feed: Pick<Feed, 'id' | 'url' | 'title'>): Promise<number> {
        if (!feed.url || !feed.id) return 0;
        let articlesAdded = 0;

        try {
            const response = await fetch(feed.url, {
                headers: { 'User-Agent': 'LaterLeaf/1.0' },
            });

            if (!response.ok) return 0;

            let xmlText = await response.text();

            // Clean up "Non-whitespace before first tag" errors
            const firstAngleBracket = xmlText.indexOf('<');
            if (firstAngleBracket > 0) {
                xmlText = xmlText.slice(firstAngleBracket);
            }

            const parsedFeed = await this.rssParser.parseString(xmlText);

            // Update feed title if it was missing or if it was temporarily set to the URL
            if ((!feed.title || feed.title === feed.url) && parsedFeed.title) {
                await this.feedsService.updateById(feed.id, { title: parsedFeed.title });
            }

            for (const item of parsedFeed.items) {
                if (!item.link) continue;

                const existing = await this.feedArticlesService.findByUrl(item.link);
                if (existing) continue;

                const rawContent = (item as { contentEncoded?: string }).contentEncoded || item.content;
                const { cleanHtml, imageUrl } = this.contentExtractionService.processFeedHtml(rawContent || '');

                let finalImageUrl = imageUrl;
                if (!finalImageUrl && item.enclosure?.url && item.enclosure.type?.startsWith('image/')) {
                    finalImageUrl = item.enclosure.url;
                }

                try {
                    await this.feedArticlesService.create({
                        url: item.link,
                        title: item.title || 'Untitled',
                        author: item.creator || item.author,
                        publishedAt: item.isoDate
                            ? new Date(item.isoDate)
                            : item.pubDate
                                ? new Date(item.pubDate)
                                : new Date(),
                        description: item.contentSnippet || item.summary,
                        contentHtml: cleanHtml,
                        imageUrl: finalImageUrl,
                        feedId: feed.id,
                        fetchedAt: new Date(),
                    });
                    articlesAdded++;
                } catch (createErr) {
                    // Ignore unique constraint violations gracefully
                    const code = (createErr as { code?: string }).code;
                    if (code !== '23505') {
                        this.logger.warn(
                            `Error creating article for feed ${feed.url}: ${(createErr as Error).message}`,
                        );
                    }
                }
            }
        } catch (err) {
            this.logger.warn(`Failed to process feed ${feed.url}: ${(err as Error).message}`);
        }

        return articlesAdded;
    }
}
