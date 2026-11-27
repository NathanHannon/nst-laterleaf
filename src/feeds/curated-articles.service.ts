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

    /**
     * Used by the public Discover page: latest curated articles first,
     * excluding podcast/audio/video URLs and round-robin interleaved by
     * `feedId` so a single prolific feed cannot monopolize the carousel.
     */
    async findLatest(limit: number): Promise<CuratedArticle[]> {
        if (limit <= 0) return [];
        const candidates = await this.curatedArticlesRepository.find({
            order: { fetchedAt: 'DESC' },
            take: Math.min(Math.max(limit * 4, limit), 200),
        });
        const valid = candidates.filter((article) => !isNonArticleUrl(article.url));

        // Group by feedId (preserving newest-first order within each feed and
        // ordering feeds by their most recent article).
        const byFeed = new Map<string, CuratedArticle[]>();
        for (const article of valid) {
            const key = article.feedId || `ungrouped-${article.id}`;
            const bucket = byFeed.get(key) ?? [];
            bucket.push(article);
            byFeed.set(key, bucket);
        }

        const buckets = Array.from(byFeed.values());
        const interleaved: CuratedArticle[] = [];
        let round = 0;

        while (interleaved.length < limit) {
            let addedInRound = false;
            for (const bucket of buckets) {
                if (round < bucket.length) {
                    interleaved.push(bucket[round]);
                    addedInRound = true;
                    if (interleaved.length >= limit) break;
                }
            }
            if (!addedInRound) break;
            round++;
        }

        return interleaved;
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
