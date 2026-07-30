import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
    FindManyOptions,
    FindOneOptions,
    FindOptionsWhere,
    In,
    Repository,
} from 'typeorm';
import { Article } from './entities/article.entity';

@Injectable()
export class ArticlesService {
    constructor(
        @InjectRepository(Article)
        private readonly articlesRepository: Repository<Article>,
    ) { }

    findById(id: string, options?: FindOneOptions<Article>): Promise<Article | null> {
        return this.articlesRepository.findOne({ where: { id }, ...options });
    }

    findByIds(ids: string[]): Promise<Article[]> {
        if (ids.length === 0) return Promise.resolve([]);
        return this.articlesRepository.find({ where: { id: In(ids) } });
    }

    findByUrl(url: string): Promise<Article | null> {
        return this.articlesRepository.findOne({ where: { url } });
    }

    create(data: Partial<Article>): Promise<Article> {
        const article = this.articlesRepository.create(data);
        return this.articlesRepository.save(article);
    }

    /**
     * Saves a pgvector embedding via raw SQL (with an explicit `::vector`
     * cast), mirroring the convention used for `Article.embedding` and
     * `ArticleChunks.chunkEmbedding` elsewhere in this codebase.
     */
    async saveEmbedding(articleId: string, embedding: number[]): Promise<void> {
        const embeddingString = `[${embedding.join(',')}]`;
        await this.articlesRepository.query(
            `UPDATE articles SET embedding = $1::vector, updated_at = NOW() WHERE id = $2`,
            [embeddingString, articleId],
        );
    }

    /**
     * Mirrors ArticleRepository.findDuplicateByEmbedding: finds the closest
     * article by pgvector cosine distance and returns it if the distance is
     * below `similarityThreshold` (i.e. it's essentially the same content).
     */
    async findDuplicateByEmbedding(
        embedding: number[],
        similarityThreshold: number = 0.01,
    ): Promise<Article | null> {
        const embeddingString = `[${embedding.join(',')}]`;

        const sql = `
            SELECT id, url, title, content, excerpt, author, image_url as "imageUrl",
                   publish_date as "publishDate", created_at as "createdAt", updated_at as "updatedAt",
                   (embedding <=> $1) as distance
            FROM public.articles
            WHERE embedding IS NOT NULL
            ORDER BY distance
            LIMIT 1;
        `;

        const results = await this.articlesRepository.query(sql, [embeddingString]);

        if (results.length === 0) {
            return null;
        }

        const match = results[0];
        const distance = parseFloat(match.distance);

        if (distance <= similarityThreshold) {
            console.log(
                `🔍 [DEDUP] Found duplicate content! Distance: ${distance.toFixed(4)} (threshold: ${similarityThreshold})`,
            );
            console.log(`   📰 Existing: "${match.title}"`);
            console.log(`   🔗 URL: ${match.url}`);

            return {
                id: match.id,
                url: match.url,
                title: match.title,
                content: match.content,
                excerpt: match.excerpt,
                author: match.author,
                imageUrl: match.imageUrl,
                publishDate: match.publishDate,
                createdAt: match.createdAt,
                updatedAt: match.updatedAt,
            } as Article;
        }

        return null;
    }

    /**
     * Reads back a single article's pgvector embedding as a plain
     * `number[]`, parsing the `[0.1,0.2,...]` textual representation
     * Postgres returns for `vector` columns. Needed for GenAI-dependent
     * features (tag/collection suggestions) that reuse an existing
     * embedding instead of paying to regenerate one.
     */
    async getEmbeddingVector(articleId: string): Promise<number[] | null> {
        const results = await this.articlesRepository.query(
            `SELECT embedding::text as embedding FROM public.articles WHERE id = $1`,
            [articleId],
        );
        const raw = results[0]?.embedding as string | undefined;
        if (!raw) return null;
        return raw
            .slice(1, -1)
            .split(',')
            .map((n) => parseFloat(n));
    }

    /**
     * Batch version of `getEmbeddingVector` — returns a Map keyed by
     * article id, omitting articles with no embedding.
     */
    async getEmbeddingsForIds(articleIds: string[]): Promise<Map<string, number[]>> {
        const map = new Map<string, number[]>();
        if (articleIds.length === 0) return map;

        const results = await this.articlesRepository.query(
            `SELECT id, embedding::text as embedding FROM public.articles WHERE id = ANY($1) AND embedding IS NOT NULL`,
            [articleIds],
        );

        for (const row of results as { id: string; embedding: string }[]) {
            map.set(
                row.id,
                row.embedding
                    .slice(1, -1)
                    .split(',')
                    .map((n) => parseFloat(n)),
            );
        }

        return map;
    }

    find(options?: FindManyOptions<Article>): Promise<Article[]> {
        return this.articlesRepository.find(options);
    }

    count(where?: FindOptionsWhere<Article>): Promise<number> {
        return this.articlesRepository.count({ where });
    }

    async updateAll(
        partial: Partial<Article>,
        where: FindOptionsWhere<Article>,
    ): Promise<{ count: number }> {
        const result = await this.articlesRepository.update(where, partial);
        return { count: result.affected ?? 0 };
    }

    async updateById(id: string, partial: Partial<Article>): Promise<void> {
        await this.articlesRepository.update({ id }, partial);
    }

    /**
     * Simplified stand-in for lb-laterleaf's `replaceById`. Merges the given
     * fields onto the existing row rather than resetting omitted columns to
     * their model defaults (a true PUT/replace). Acceptable for now since the
     * frontend does not currently call PUT /articles/:id.
     */
    async replaceById(id: string, entity: Partial<Article>): Promise<void> {
        await this.articlesRepository.update({ id }, entity);
    }

    /**
     * Atomically increments/decrements bookmark_count.
     * Mirrors ArticleRepository.updateBookmarkCountAtomic.
     */
    async updateBookmarkCountAtomic(articleId: string, delta: number): Promise<void> {
        await this.articlesRepository.query(
            `UPDATE articles SET bookmark_count = GREATEST(0, COALESCE(bookmark_count, 0) + $1), updated_at = NOW() WHERE id = $2`,
            [delta, articleId],
        );
    }

    /**
     * Atomically increments/decrements save_count.
     * Mirrors ArticleRepository.updateSaveCountAtomic.
     */
    async updateSaveCountAtomic(articleId: string, delta: number): Promise<void> {
        await this.articlesRepository.query(
            `UPDATE articles SET save_count = GREATEST(0, COALESCE(save_count, 0) + $1), updated_at = NOW() WHERE id = $2`,
            [delta, articleId],
        );
    }

    /**
     * Finds a user's saved articles ordered by embedding similarity to the
     * given query embedding. Mirrors ArticleRepository.semanticSearch. Note:
     * does NOT select `content` (matches the original SQL, which also
     * omits it) — callers needing full content must fetch it separately.
     */
    async semanticSearch(embedding: number[], userId: string, limit = 10): Promise<Article[]> {
        const embeddingString = `[${embedding.join(',')}]`;
        const sql = `
            SELECT a.id, a.url, a.title, a.excerpt, a.author, a.image_url as "imageUrl",
                   ua.is_bookmarked as "isBookmarked", ua.is_archived as "isArchived",
                   (a.embedding <=> $2) as distance
            FROM public.articles a
            INNER JOIN public.user_articles ua ON a.id = ua.article_id
            WHERE ua.user_id = $1 AND a.embedding IS NOT NULL
            ORDER BY distance
            LIMIT $3;
        `;
        return this.articlesRepository.query(sql, [userId, embeddingString, limit]);
    }

    /**
     * Finds articles similar to a given embedding vector with weighted
     * scoring. Combines semantic similarity (60%), bookmark count (30%),
     * and save count (10%). Mirrors ArticleRepository.findSimilarWeighted.
     */
    async findSimilarWeighted(
        targetEmbedding: number[],
        options: { limit?: number; excludeIds?: string[] } = {},
    ): Promise<(Article & { weightedScore: number })[]> {
        const { limit = 10, excludeIds = [] } = options;
        const embeddingString = `[${targetEmbedding.join(',')}]`;

        let sql: string;
        const params: unknown[] = [embeddingString];

        const baseSelect = `
            SELECT
              id, title, url, excerpt, author,
              image_url as "imageUrl",
              publish_date as "publishDate",
              created_at as "createdAt",
              updated_at as "updatedAt",
              content,
              is_eligible_for_recommendation as "isEligibleForRecommendation",
              site_name as "siteName",
              COALESCE(bookmark_count, 0) as bookmark_count,
              COALESCE(save_count, 0) as save_count,
              (embedding <=> $1) as cosine_distance,
              (1 - (embedding <=> $1)) as semantic_score
            FROM articles
            WHERE embedding IS NOT NULL
              AND is_eligible_for_recommendation = true`;

        if (excludeIds.length > 0) {
            sql = `${baseSelect} AND id != ALL($2) ORDER BY semantic_score DESC LIMIT $3;`;
            params.push(excludeIds, Math.max(limit * 3, 100));
        } else {
            sql = `${baseSelect} ORDER BY semantic_score DESC LIMIT $2;`;
            params.push(Math.max(limit * 3, 100));
        }

        const rawResults: any[] = await this.articlesRepository.query(sql, params);
        if (!rawResults || rawResults.length === 0) {
            return [];
        }

        // Normalize popularity counts to 0-1 range using the actual max values
        // in this result set, so popular articles get fair weight regardless
        // of absolute numbers.
        const maxBookmarks = Math.max(...rawResults.map((r) => Number(r.bookmark_count)), 1);
        const maxSaves = Math.max(...rawResults.map((r) => Number(r.save_count)), 1);

        const articlesWithScores = rawResults.map((row) => {
            const semanticScore = parseFloat(row.semantic_score) || 0;
            const normalizedBookmarks = Number(row.bookmark_count) / maxBookmarks;
            const normalizedSaves = Number(row.save_count) / maxSaves;

            // Weights: 60% semantic, 30% bookmarks, 10% saves
            const weightedScore = 0.6 * semanticScore + 0.3 * normalizedBookmarks + 0.1 * normalizedSaves;

            const article = Object.assign(new Article(), {
                id: row.id,
                title: row.title,
                url: row.url,
                excerpt: row.excerpt,
                author: row.author,
                imageUrl: row.imageUrl,
                publishDate: row.publishDate,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
                content: row.content,
                isEligibleForRecommendation: row.isEligibleForRecommendation,
                bookmarkCount: Number(row.bookmark_count),
                saveCount: Number(row.save_count),
            }) as Article & { weightedScore: number };
            article.weightedScore = weightedScore;
            return article;
        });

        return articlesWithScores.sort((a, b) => b.weightedScore - a.weightedScore).slice(0, limit);
    }

    /**
     * Fetches a pool of popular articles (by weighted bookmark/save count),
     * excluding the given ids. Mirrors the popularity-ranking query in
     * RecommendationService.getPopularArticles.
     */
    async findPopular(excludeIds: string[], poolSize: number): Promise<Article[]> {
        const baseSelect = `
            SELECT id, title, url, excerpt, author,
              image_url as "imageUrl",
              publish_date as "publishDate",
              created_at as "createdAt",
              updated_at as "updatedAt",
              content,
              is_eligible_for_recommendation as "isEligibleForRecommendation",
              site_name as "siteName",
              COALESCE(bookmark_count, 0) as "bookmarkCount",
              COALESCE(save_count, 0) as "saveCount"
            FROM articles
            WHERE is_eligible_for_recommendation = true`;

        let sql: string;
        const params: unknown[] = [];

        if (excludeIds.length > 0) {
            sql = `${baseSelect} AND id != ALL($1)
                ORDER BY (COALESCE(bookmark_count, 0) * 0.75 + COALESCE(save_count, 0) * 0.25) DESC
                LIMIT $2;`;
            params.push(excludeIds, poolSize);
        } else {
            sql = `${baseSelect}
                ORDER BY (COALESCE(bookmark_count, 0) * 0.75 + COALESCE(save_count, 0) * 0.25) DESC
                LIMIT $1;`;
            params.push(poolSize);
        }

        return this.articlesRepository.query(sql, params);
    }
}
