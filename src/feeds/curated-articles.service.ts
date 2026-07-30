import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { CuratedArticle } from './entities/curated-article.entity';

/**
 * Mirrors lb-laterleaf/src/repositories/curated-article.repository.ts.
 */
@Injectable()
export class CuratedArticlesService {
    constructor(
        @InjectRepository(CuratedArticle)
        private readonly curatedArticlesRepository: Repository<CuratedArticle>,
    ) { }

    /** Used by the public Discover page: latest curated articles first. */
    findLatest(limit: number): Promise<CuratedArticle[]> {
        return this.curatedArticlesRepository.find({
            order: { fetchedAt: 'DESC' },
            take: limit,
        });
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
