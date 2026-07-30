import { Injectable, Logger } from '@nestjs/common';
import Parser from 'rss-parser';
import { ContentExtractionService } from '../content-extraction/content-extraction.service';
import { CuratedFeedsService } from './curated-feeds.service';

/** Mirrors lb-laterleaf/src/interfaces/curated-feed.interface.ts. */
export interface FeedItem {
    title: string;
    link: string;
    sourceName: string;
    feedId: string;
    contentHtml?: string;
    description?: string;
    author?: string;
    imageUrl?: string;
}

/**
 * Mirrors lb-laterleaf/src/services/curated-feed.service.ts. Fetches and
 * parses all active admin-curated RSS feeds, used to populate the
 * `CuratedArticle` table for the public Discover page.
 */
@Injectable()
export class CuratedFeedFetchingService {
    private readonly logger = new Logger(CuratedFeedFetchingService.name);
    private readonly parser: Parser;

    constructor(
        private readonly curatedFeedsService: CuratedFeedsService,
        private readonly contentExtractionService: ContentExtractionService,
    ) {
        this.parser = new Parser({
            customFields: {
                item: [['content:encoded', 'contentEncoded']],
            },
        });
    }

    /**
     * Fetches and parses all active curated RSS feeds from the database.
     * @returns A flattened array of all articles from all feeds.
     */
    async fetchAllFeeds(): Promise<FeedItem[]> {
        this.logger.log('Starting to fetch all curated feeds from database...');
        const allItems: FeedItem[] = [];

        const feeds = await this.curatedFeedsService.findActive();
        this.logger.log(`Found ${feeds.length} active curated feeds in the database.`);

        for (const feedConfig of feeds) {
            try {
                const feed = await this.parser.parseURL(feedConfig.url);
                this.logger.log(`Fetched ${feed.items.length} items from ${feedConfig.name}`);

                feed.items.forEach((item) => {
                    if (item.title && item.link) {
                        const rawContent = (item as { contentEncoded?: string }).contentEncoded || item.content;
                        const { cleanHtml, imageUrl } = this.contentExtractionService.processFeedHtml(rawContent);

                        let finalImageUrl = imageUrl;
                        if (
                            !finalImageUrl &&
                            item.enclosure?.url &&
                            item.enclosure.type?.startsWith('image/')
                        ) {
                            finalImageUrl = item.enclosure.url;
                        }

                        allItems.push({
                            title: item.title,
                            link: item.link,
                            sourceName: feedConfig.name,
                            feedId: feedConfig.id ?? '',
                            contentHtml: cleanHtml,
                            description: item.contentSnippet || item.summary,
                            author: item.creator,
                            imageUrl: finalImageUrl,
                        });
                    }
                });
            } catch (error) {
                this.logger.error(`Failed to fetch or parse feed: ${feedConfig.name}`, error);
            }
        }

        this.logger.log(`Finished fetching. Found ${allItems.length} total items.`);
        return allItems;
    }
}
