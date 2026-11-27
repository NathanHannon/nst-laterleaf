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

export interface RecommendationCandidate extends Article {
    semanticScore: number;
    weightedScore: number;
    embeddingVector?: number[];
}

export interface RelatedLibraryArticle {
    id: string;
    title?: string;
    excerpt?: string;
    imageUrl?: string;
    url?: string;
    siteName?: string;
    readingTime: number;
    similarity: number;
    isBookmarked: boolean;
    isArchived: boolean;
    status: string;
    progressPercentage: number;
    savedAt?: string;
    sharedTagCount: number;
}

/**
 * Computes an anti-graveyard resurfacing score for related articles already in
 * the user's library. Keeps semantic similarity as the foundation while
 * prioritizing unfinished and forgotten unread saves, rewarding shared tags
 * and bite-sized quick wins, and gently down-ranking already-read/archived items.
 */
export function computeRelatedLibraryScore(params: {
    similarity: number;
    status?: string;
    isArchived?: boolean;
    progressPercentage?: number;
    savedAt?: Date | string | null;
    readingTime?: number;
    sharedTagCount?: number;
    nowMs?: number;
}): number {
    const similarity = Math.max(0, Math.min(1, params.similarity || 0));
    const progress = Math.max(0, Math.min(100, Number(params.progressPercentage) || 0));
    const status = (params.status || 'unread').toLowerCase();
    const isFinished =
        Boolean(params.isArchived) ||
        status === 'read' ||
        status === 'archived' ||
        progress >= 80;
    const isInProgress = !isFinished && progress > 0;

    // Prioritize unfinished ("finish what you started") and unread backlog over already-read saves.
    const statusMultiplier = isInProgress ? 1.28 : !isFinished ? 1.22 : 0.78;

    let bonus = 0;

    // Gentle "dusty backlog" bonus for unread/in-progress saves sitting 14+ days.
    if (!isFinished && params.savedAt) {
        const nowMs = params.nowMs ?? Date.now();
        const savedMs = new Date(params.savedAt).getTime();
        if (Number.isFinite(savedMs)) {
            const daysSaved = Math.max(0, (nowMs - savedMs) / (1000 * 60 * 60 * 24));
            if (daysSaved >= 14) {
                bonus += 0.08 * Math.min(1, (daysSaved - 14) / 76);
            }
        }
    }

    // Small quick-win nudge for bite-sized unread articles (2-7 min read).
    const readingTime = Number(params.readingTime) || 0;
    if (!isFinished && readingTime >= 2 && readingTime <= 7) {
        bonus += 0.03;
    }

    // Explicit personal connection via shared user tags.
    const sharedTags = Math.max(0, Number(params.sharedTagCount) || 0);
    if (sharedTags > 0) {
        bonus += Math.min(0.1, sharedTags * 0.05);
    }

    return similarity * statusMultiplier + bonus;
}

function parsePgVector(raw: string | undefined | null): number[] | undefined {
    if (!raw || raw.length < 2) return undefined;
    const values = raw
        .slice(1, -1)
        .split(',')
        .map((n) => parseFloat(n));
    return values.length > 0 && Number.isFinite(values[0]) ? values : undefined;
}

/**
 * Computes a pool-independent, semantic-gated score combining:
 * - Semantic cosine similarity (primary driver)
 * - Log-scaled bookmark/save volume + Bayesian bookmark-to-save quality ratio
 * - Gentle freshness boost (preserves evergreen articles)
 */
export function computeCandidateScore(params: {
    semanticScore: number;
    bookmarkCount: number;
    saveCount: number;
    publishedOrCreatedAt?: Date | string | null;
    nowMs?: number;
}): number {
    const semanticScore = Math.max(0, Math.min(1, params.semanticScore || 0));
    const bookmarks = Math.max(0, Number(params.bookmarkCount) || 0);
    const saves = Math.max(0, Number(params.saveCount) || 0);

    const bookmarkSignal = Math.min(1, Math.log1p(bookmarks) / Math.log1p(50));
    const saveSignal = Math.min(1, Math.log1p(saves) / Math.log1p(100));
    // Bayesian conversion rate: rewards articles that a high share of savers bookmark.
    const qualityRatio = Math.min(1, (bookmarks + 0.5) / (saves + 3));
    const popularityScore = 0.5 * bookmarkSignal + 0.2 * saveSignal + 0.3 * qualityRatio;

    const nowMs = params.nowMs ?? Date.now();
    const refMs = params.publishedOrCreatedAt ? new Date(params.publishedOrCreatedAt).getTime() : NaN;
    const ageDays = Number.isFinite(refMs) ? Math.max(0, (nowMs - refMs) / (1000 * 60 * 60 * 24)) : 180;
    // Half-life ~230 days, applied as a gentle 0.88..1.00 multiplier so evergreen articles remain competitive.
    const freshnessMultiplier = 0.88 + 0.12 * Math.exp(-0.003 * ageDays);

    return semanticScore * (0.72 + 0.28 * popularityScore) * freshnessMultiplier;
}

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
                 SELECT a.id, a.url, a.title, a.excerpt, a.author,
                     a.image_url AS "imageUrl", a.site_name AS "siteName",
                     a.site_icon AS "siteIcon", a.og_image AS "ogImage",
                     a.og_description AS "ogDescription", a.theme_color AS "themeColor",
                       a.created_at AS "createdAt", a.updated_at AS "updatedAt",
                     ua.id AS "userArticleId", ua.is_bookmarked AS "isBookmarked",
                     ua.is_liked AS "isLiked", ua.is_archived AS "isArchived",
                     ua.summary, ua.audio_location AS "audioLocation",
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
     * Finds articles in the user's library that are semantically related to
     * the given article using pgvector cosine similarity, then re-ranks them
     * with an anti-graveyard score that surfaces unread, in-progress, and
     * forgotten older saves ahead of already-read items.
     */
    async findRelatedInUserLibrary(
        articleId: string,
        embedding: number[],
        userId: string,
        limit = 3,
        minSimilarity = 0.45,
    ): Promise<RelatedLibraryArticle[]> {
        const embeddingString = `[${embedding.join(',')}]`;
        const maxDistance = 1 - minSimilarity;
        const candidatePoolLimit = Math.max(limit * 5, 20);
        const sql = `
            SELECT
                a.id,
                a.title,
                a.excerpt,
                a.image_url AS "imageUrl",
                a.url,
                a.site_name AS "siteName",
                COALESCE(a.reading_time, 0) AS "readingTime",
                (1 - (a.embedding <=> $2)) AS similarity,
                COALESCE(ua.is_bookmarked, false) AS "isBookmarked",
                COALESCE(ua.is_archived, false) AS "isArchived",
                COALESCE(ua.status, 'unread') AS status,
                COALESCE(ua.progress_percentage, 0) AS "progressPercentage",
                ua.created_at AS "savedAt",
                COALESCE((
                    SELECT COUNT(DISTINCT uat_other.tag_id)
                    FROM public.user_article_tags uat_other
                    INNER JOIN public.user_article_tags uat_src ON uat_other.tag_id = uat_src.tag_id
                    INNER JOIN public.user_articles ua_src ON uat_src.user_article_id = ua_src.id
                    WHERE uat_other.user_article_id = ua.id
                      AND ua_src.user_id = $1
                      AND ua_src.article_id = $3
                ), 0) AS "sharedTagCount"
            FROM public.articles a
            INNER JOIN public.user_articles ua ON a.id = ua.article_id
            WHERE ua.user_id = $1
              AND a.id != $3
              AND a.embedding IS NOT NULL
              AND (a.embedding <=> $2) <= $4
              AND (a.embedding <=> $2) > 0.02
            ORDER BY a.embedding <=> $2 ASC
            LIMIT $5;
        `;
        const rows: {
            id: string;
            title: string | null;
            excerpt: string | null;
            imageUrl: string | null;
            url: string | null;
            siteName: string | null;
            readingTime: string | number | null;
            similarity: string | number;
            isBookmarked: boolean;
            isArchived: boolean;
            status: string | null;
            progressPercentage: string | number | null;
            savedAt: Date | string | null;
            sharedTagCount: string | number | null;
        }[] = await this.articlesRepository.query(sql, [
            userId,
            embeddingString,
            articleId,
            maxDistance,
            candidatePoolLimit,
        ]);

        const nowMs = Date.now();
        return rows
            .map((row) => {
                const similarity = parseFloat(String(row.similarity)) || 0;
                const readingTime = Number(row.readingTime) || 0;
                const progressPercentage = Number(row.progressPercentage) || 0;
                const sharedTagCount = Number(row.sharedTagCount) || 0;
                const status = row.status || 'unread';
                const isArchived = Boolean(row.isArchived);
                const savedAt = row.savedAt ? new Date(row.savedAt).toISOString() : undefined;

                const item: RelatedLibraryArticle = {
                    id: row.id,
                    title: row.title ?? undefined,
                    excerpt: row.excerpt ?? undefined,
                    imageUrl: row.imageUrl ?? undefined,
                    url: row.url ?? undefined,
                    siteName: row.siteName ?? undefined,
                    readingTime,
                    similarity,
                    isBookmarked: Boolean(row.isBookmarked),
                    isArchived,
                    status,
                    progressPercentage,
                    savedAt,
                    sharedTagCount,
                };

                const score = computeRelatedLibraryScore({
                    similarity,
                    status,
                    isArchived,
                    progressPercentage,
                    savedAt,
                    readingTime,
                    sharedTagCount,
                    nowMs,
                });

                return { item, score };
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map(({ item }) => item);
    }

    async keywordSearch(query: string, userId: string, limit = 20): Promise<Article[]> {
        const searchTerm = `%${query}%`;
        const sql = `
                 SELECT a.id, a.url, a.title, a.excerpt, a.author,
                     a.image_url AS "imageUrl", a.site_name AS "siteName",
                     a.site_icon AS "siteIcon", a.og_image AS "ogImage",
                     a.og_description AS "ogDescription", a.theme_color AS "themeColor",
                   a.created_at AS "createdAt", a.updated_at AS "updatedAt",
                   ua.id AS "userArticleId", ua.is_bookmarked AS "isBookmarked",
                     ua.is_liked AS "isLiked", ua.is_archived AS "isArchived",
                     ua.summary, ua.audio_location AS "audioLocation",
                   CASE WHEN a.title ILIKE $2 THEN 0 ELSE 1 END AS "searchRank"
            FROM public.articles a
            INNER JOIN public.user_articles ua ON a.id = ua.article_id
            WHERE ua.user_id = $1
              AND (a.title ILIKE $2 OR a.author ILIKE $2 OR a.excerpt ILIKE $2 OR a.content ILIKE $2)
            ORDER BY "searchRank", a.created_at DESC
            LIMIT $3
        `;
        return this.articlesRepository.query(sql, [userId, searchTerm, limit]);
    }

    /**
     * Finds articles similar to a given embedding vector using an index-friendly
     * pgvector cosine distance search (`ORDER BY embedding <=> $1 ASC`), then
     * scores candidates with a pool-independent semantic-gated popularity &
     * freshness formula so scores remain directly comparable across clusters.
     */
    async findSimilarWeighted(
        targetEmbedding: number[],
        options: { limit?: number; excludeIds?: string[]; minSimilarity?: number } = {},
    ): Promise<RecommendationCandidate[]> {
        const { limit = 10, excludeIds = [], minSimilarity = 0.35 } = options;
        const embeddingString = `[${targetEmbedding.join(',')}]`;
        const maxDistance = 1 - minSimilarity;
        const fetchLimit = Math.max(limit * 3, 60);

        let sql: string;
        const params: unknown[] = [embeddingString, maxDistance];

        const baseSelect = `
            SELECT
              id, title, url, excerpt, author,
              image_url as "imageUrl",
              publish_date as "publishDate",
              created_at as "createdAt",
              updated_at as "updatedAt",
              is_eligible_for_recommendation as "isEligibleForRecommendation",
              site_name as "siteName",
              reading_time as "readingTime",
              COALESCE(bookmark_count, 0) as bookmark_count,
              COALESCE(save_count, 0) as save_count,
              embedding::text as embedding_text,
              (embedding <=> $1) as cosine_distance,
              (1 - (embedding <=> $1)) as semantic_score
            FROM articles
            WHERE embedding IS NOT NULL
              AND is_eligible_for_recommendation = true
              AND (embedding <=> $1) <= $2`;

        if (excludeIds.length > 0) {
            sql = `${baseSelect} AND id != ALL($3) ORDER BY embedding <=> $1 ASC LIMIT $4;`;
            params.push(excludeIds, fetchLimit);
        } else {
            sql = `${baseSelect} ORDER BY embedding <=> $1 ASC LIMIT $3;`;
            params.push(fetchLimit);
        }

        const rawResults: any[] = await this.articlesRepository.query(sql, params);
        if (!rawResults || rawResults.length === 0) {
            return [];
        }

        const nowMs = Date.now();
        const articlesWithScores = rawResults.map((row) => {
            const semanticScore = parseFloat(row.semantic_score) || 0;
            const bookmarkCount = Number(row.bookmark_count) || 0;
            const saveCount = Number(row.save_count) || 0;

            const weightedScore = computeCandidateScore({
                semanticScore,
                bookmarkCount,
                saveCount,
                publishedOrCreatedAt: row.publishDate ?? row.createdAt,
                nowMs,
            });

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
                siteName: row.siteName,
                readingTime: Number(row.readingTime) || 0,
                isEligibleForRecommendation: row.isEligibleForRecommendation,
                bookmarkCount,
                saveCount,
            }) as RecommendationCandidate;
            article.semanticScore = semanticScore;
            article.weightedScore = weightedScore;
            article.embeddingVector = parsePgVector(row.embedding_text);
            return article;
        });

        return articlesWithScores.sort((a, b) => b.weightedScore - a.weightedScore).slice(0, limit);
    }

    /**
     * Fetches a pool of popular articles ranked by log-scaled bookmark/save
     * engagement with gentle freshness gravity so older articles do not
     * permanently camp at the top of the feed.
     */
    async findPopular(excludeIds: string[], poolSize: number): Promise<Article[]> {
        const baseSelect = `
            SELECT id, title, url, excerpt, author,
              image_url as "imageUrl",
              publish_date as "publishDate",
              created_at as "createdAt",
              updated_at as "updatedAt",
              is_eligible_for_recommendation as "isEligibleForRecommendation",
              site_name as "siteName",
              reading_time as "readingTime",
              COALESCE(bookmark_count, 0) as "bookmarkCount",
              COALESCE(save_count, 0) as "saveCount"
            FROM articles
            WHERE is_eligible_for_recommendation = true`;

        const orderByClause = `
            ORDER BY (
                (LN(1 + COALESCE(bookmark_count, 0)) * 0.75 + LN(1 + COALESCE(save_count, 0)) * 0.25 + 0.1)
                / POWER(GREATEST(0, EXTRACT(EPOCH FROM (NOW() - COALESCE(publish_date, created_at))) / 86400.0) + 7.0, 0.35)
            ) DESC`;

        let sql: string;
        const params: unknown[] = [];

        if (excludeIds.length > 0) {
            sql = `${baseSelect} AND id != ALL($1) ${orderByClause} LIMIT $2;`;
            params.push(excludeIds, poolSize);
        } else {
            sql = `${baseSelect} ${orderByClause} LIMIT $1;`;
            params.push(poolSize);
        }

        return this.articlesRepository.query(sql, params);
    }
}
