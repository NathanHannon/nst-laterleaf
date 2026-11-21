import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { CuratedArticle } from './entities/curated-article.entity';
import { isNonArticleUrl } from './feed-item-filter';

/**
 */
@Injectable()
export class CuratedArticlesService {
    constructor(
        @InjectRepository(CuratedArticle)
        private readonly curatedArticlesRepository: Repository<CuratedArticle>,
    ) { }

    /** Used by the public Discover page: latest curated articles first, excluding podcast/audio/video URLs. */
    async findLatest(limit: number): Promise<CuratedArticle[]> {
        const candidates = await this.curatedArticlesRepository.find({
            order: { fetchedAt: 'DESC' },
            take: Math.min(Math.max(limit * 2, limit), 200),
        });
        return candidates.filter((article) => !isNonArticleUrl(article.url)).slice(0, limit);
    }

    findByFeedId(feedId: string): Promise<CuratedArticle[]> {
        return this.curatedArticlesRepository.find({ where: { feedId } });
    }

    create(data: Partial<CuratedArticle>): Promise<CuratedArticle> {
        const article = this.curatedArticlesRepository.create(data);
        return this.curatedArticlesRepository.save(article);
    }

    /**
     * Deletes curated articles older than `olderThan`. Used by the daily
     * cleanup cron job.
     */
    async deleteFetchedBefore(olderThan: Date): Promise<number> {
        const result = await this.curatedArticlesRepository.delete({
            fetchedAt: LessThan(olderThan),
        });
        return result.affected ?? 0;
    }
}
