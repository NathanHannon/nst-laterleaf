import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Feed } from './entities/feed.entity';
import { FeedArticle } from './entities/feed-article.entity';
import { UserFeed } from './entities/user-feed.entity';
import { CuratedFeed } from './entities/curated-feed.entity';
import { CuratedArticle } from './entities/curated-article.entity';
import { FeedsService } from './feeds.service';
import { FeedArticlesService } from './feed-articles.service';
import { UserFeedsService } from './user-feeds.service';
import { CuratedFeedsService } from './curated-feeds.service';
import { CuratedArticlesService } from './curated-articles.service';
import { FeedFetchingService } from './feed-fetching.service';
import { CuratedFeedFetchingService } from './curated-feed-fetching.service';
import { FeedsCronService } from './feeds-cron.service';
import { RssController } from './rss.controller';
import { CuratedFeedController } from './curated-feed.controller';
import { CuratedFeedCuratedArticleController } from './curated-feed-curated-article.controller';
import { CuratedArticleController } from './curated-article.controller';
import { UserFeedController } from './user-feed.controller';
import { UsersModule } from '../users/users.module';
import { ArticlesModule } from '../articles/articles.module';
import { ContentExtractionModule } from '../content-extraction/content-extraction.module';

/**
 * Ports the "Feeds/Discover pipeline" domain from lb-laterleaf:
 * `rss.controller.ts`, `curated-feed.controller.ts`,
 * `curated-feed-curated-article.controller.ts`, `curated-article.controller.ts`,
 * `user-feed.controller.ts`, plus `feed-fetching.service.ts` and
 * `curated-feed.service.ts` (renamed `CuratedFeedFetchingService` to avoid
 * clashing with the `CuratedFeedsService` CRUD service), and the
 * feed-related cron jobs from `cron-job.service.ts` (see FeedsCronService).
 */
@Module({
    imports: [
        TypeOrmModule.forFeature([Feed, FeedArticle, UserFeed, CuratedFeed, CuratedArticle]),
        UsersModule,
        ArticlesModule,
        ContentExtractionModule,
    ],
    providers: [
        FeedsService,
        FeedArticlesService,
        UserFeedsService,
        CuratedFeedsService,
        CuratedArticlesService,
        FeedFetchingService,
        CuratedFeedFetchingService,
        FeedsCronService,
    ],
    controllers: [
        RssController,
        CuratedFeedController,
        CuratedFeedCuratedArticleController,
        CuratedArticleController,
        UserFeedController,
    ],
})
export class FeedsModule { }
