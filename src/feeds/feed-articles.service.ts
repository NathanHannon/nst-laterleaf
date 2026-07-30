import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { FeedArticle } from './entities/feed-article.entity';

/**
 * articles fetched from a user's subscribed feeds.
 */
@Injectable()
export class FeedArticlesService {
    constructor(
        @InjectRepository(FeedArticle)
        private readonly feedArticlesRepository: Repository<FeedArticle>,
    ) { }

    findByUrl(url: string): Promise<FeedArticle | null> {
        return this.feedArticlesRepository.findOne({ where: { url } });
    }

    create(data: Partial<FeedArticle>): Promise<FeedArticle> {
        const article = this.feedArticlesRepository.create(data);
        return this.feedArticlesRepository.save(article);
    }

    findByFeedIds(feedIds: string[], limit: number): Promise<FeedArticle[]> {
        if (feedIds.length === 0) return Promise.resolve([]);
        return this.feedArticlesRepository.find({
            where: { feedId: In(feedIds) },
            order: { publishedAt: 'DESC' },
            take: limit,
        });
    }
}
