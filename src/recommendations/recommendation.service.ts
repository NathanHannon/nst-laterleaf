import { Injectable } from '@nestjs/common';
import { Article } from '../articles/entities/article.entity';
import { ArticlesService } from '../articles/articles.service';
import { UserArticlesService } from '../articles/user-articles.service';
import { UsersService } from '../users/users.service';
import { UserArticleTagsService } from '../tags/user-article-tags.service';
import {
    InterestItem,
    allocateClusterBudgets,
    applyDismissalPenalties,
    clusterInterests,
    extractDomain,
    mergeClusterCandidates,
    rerankWithDiversity,
    samplePopularWithDiversity,
} from './recommendation.algorithms';

/**
 * Personalized article recommendations via a multi-stage hybrid pipeline:
 * 1. Rich engagement weighting over the user's library (recency anchored on
 *    lastReadAt/createdAt, likes, bookmarks, tag counts, reading progress,
 *    highlights, chat, and summaries/audio).
 * 2. Adaptive deterministic K-Means++ clustering with near-duplicate cluster
 *    merging and proportional candidate budgets.
 * 3. Index-friendly pgvector similarity search per cluster with pool-independent
 *    semantic-gated popularity + freshness scoring.
 * 4. Max-score deduplication with multi-interest bridge boosts, targeted
 *    per-candidate dismissal penalties (embedding similarity + domain fatigue),
 *    and MMR diversity + domain-cap re-ranking.
 * 5. Cold-start blending for users with 1-4 saved articles and dismissal-aware
 *    popularity fallback.
 */
@Injectable()
export class RecommendationService {
    constructor(
        private readonly articlesService: ArticlesService,
        private readonly userArticlesService: UserArticlesService,
        private readonly usersService: UsersService,
        private readonly userArticleTagsService: UserArticleTagsService,
    ) { }

    async generateForUser(
        userId: string,
        limit = 12,
        poolSize = 60,
        previouslyRecommendedIds: string[] = [],
    ): Promise<Article[]> {
        try {
            // 1. Fetch user's saved-article links and dismissed IDs in parallel.
            const [userArticles, user] = await Promise.all([
                this.userArticlesService.findAllForUser(userId),
                this.usersService.findById(userId),
            ]);

            if (userArticles.length === 0) return [];

            const userArticleMap = new Map(
                userArticles
                    .filter((ua): ua is typeof ua & { articleId: string } => typeof ua.articleId === 'string')
                    .map((ua) => [ua.articleId, ua]),
            );
            const userArticleIds = Array.from(userArticleMap.keys());
            const dismissedArticleIds = user?.dismissedArticleIds ?? [];

            if (userArticleIds.length === 0) {
                return this.getPopularArticles(userId, limit, poolSize, previouslyRecommendedIds);
            }

            // 2. Fetch embeddings, titles, and tag counts for the user's saved articles.
            const userArticleIdsForTags = Array.from(userArticleMap.values())
                .map((ua) => ua.id)
                .filter((id): id is string => Boolean(id));

            const [embeddingMap, articleRows, taggedRecords] = await Promise.all([
                this.articlesService.getEmbeddingsForIds(userArticleIds),
                this.articlesService.findByIds(userArticleIds),
                this.userArticleTagsService.findByUserArticleIds(userArticleIdsForTags),
            ]);

            const titleById = new Map(articleRows.map((a) => [a.id, a.title]));

            const tagCountByUserArticleId = new Map<string, number>();
            for (const record of taggedRecords) {
                tagCountByUserArticleId.set(
                    record.userArticleId,
                    (tagCountByUserArticleId.get(record.userArticleId) ?? 0) + 1,
                );
            }

            const validItems: InterestItem[] = userArticleIds
                .filter((id) => embeddingMap.has(id))
                .map((id) => {
                    const ua = userArticleMap.get(id)!;
                    const createdAt = (ua.createdAt ? new Date(ua.createdAt) : new Date()).toISOString();
                    const lastReadAt = ua.lastReadAt ? new Date(ua.lastReadAt).toISOString() : undefined;
                    return {
                        id,
                        title: titleById.get(id),
                        embedding: embeddingMap.get(id) as number[],
                        createdAt,
                        lastReadAt,
                        status: ua.status,
                        progressPercentage: ua.progressPercentage ?? 0,
                        isLiked: Boolean(ua.isLiked),
                        isBookmarked: Boolean(ua.isBookmarked),
                        tagCount: ua.id ? (tagCountByUserArticleId.get(ua.id) ?? 0) : 0,
                        hasHighlights: Array.isArray(ua.highlights) && ua.highlights.length > 0,
                        hasChat: Array.isArray(ua.chatHistory) && ua.chatHistory.length > 0,
                        hasSummaryOrAudio: Boolean(ua.summary || ua.audioLocation),
                    };
                });

            if (validItems.length === 0) {
                return this.getPopularArticles(userId, limit, poolSize, previouslyRecommendedIds);
            }

            // 3. Adaptive K-Means++ clustering over user interest embeddings.
            const clusters = clusterInterests(validItems);
            if (clusters.length === 0) {
                return this.getPopularArticles(userId, limit, poolSize, previouslyRecommendedIds);
            }

            // 4. Parallel candidate retrieval per cluster + dismissed metadata fetch.
            const allExcludedIds = [
                ...new Set([...userArticleIds, ...previouslyRecommendedIds, ...dismissedArticleIds]),
            ];
            const budgets = allocateClusterBudgets(clusters, poolSize);

            const [clusterResults, dismissedEmbeddingMap, dismissedArticles] = await Promise.all([
                Promise.all(
                    clusters.map((cluster, idx) =>
                        this.articlesService.findSimilarWeighted(cluster.centroid, {
                            limit: budgets[idx],
                            excludeIds: allExcludedIds,
                        }),
                    ),
                ),
                dismissedArticleIds.length > 0
                    ? this.articlesService.getEmbeddingsForIds(dismissedArticleIds)
                    : Promise.resolve(new Map<string, number[]>()),
                dismissedArticleIds.length > 0
                    ? this.articlesService.findByIds(dismissedArticleIds)
                    : Promise.resolve([] as Article[]),
            ]);

            // Preserve chronological order (oldest -> newest) for dismissed embeddings.
            const dismissedEmbeddings = dismissedArticleIds
                .map((id) => dismissedEmbeddingMap.get(id))
                .filter((emb): emb is number[] => Boolean(emb && emb.length > 0));

            const dismissedDomainCounts = new Map<string, number>();
            for (const dismissed of dismissedArticles) {
                const domain = extractDomain(dismissed.url, dismissed.siteName);
                if (domain) {
                    dismissedDomainCounts.set(domain, (dismissedDomainCounts.get(domain) ?? 0) + 1);
                }
            }

            // 5. Merge (keeping max score + multi-cluster bridge boost), apply
            // targeted per-candidate dismissal penalties, and MMR-rerank with domain caps.
            const mergedCandidates = mergeClusterCandidates(clusterResults, clusters);
            const penalizedCandidates = applyDismissalPenalties(
                mergedCandidates,
                dismissedEmbeddings,
                dismissedDomainCounts,
            );

            // For cold-start users (1-4 saved articles), blend personalized picks
            // with popular articles if personalized candidates are sparse or narrow.
            const personalizedLimit = validItems.length < 5 ? Math.min(limit, Math.max(6, Math.ceil(limit * 0.67))) : limit;
            const reranked = rerankWithDiversity(penalizedCandidates, {
                limit: personalizedLimit,
            });

            const personalizedArticles = reranked.map(({ article }) => {
                const { weightedScore, semanticScore, embeddingVector, ...data } = article;
                return data as Article;
            });

            if (personalizedArticles.length === 0) {
                return [];
            }

            if (personalizedArticles.length < limit && validItems.length < 5) {
                const remainingNeeded = limit - personalizedArticles.length;
                const blendExcluded = [
                    ...allExcludedIds,
                    ...personalizedArticles.map((a) => a.id),
                ];
                const popularPool = await this.articlesService.findPopular(blendExcluded, poolSize);
                const filler = samplePopularWithDiversity(popularPool, { limit: remainingNeeded });
                return [...personalizedArticles, ...filler];
            }

            return personalizedArticles;
        } catch (error) {
            console.error('Error generating recommendations:', error);
            return this.getPopularArticles(userId, limit, poolSize, previouslyRecommendedIds);
        }
    }

    /**
     * Popularity-based fallback: excludes saved, previously recommended, and
     * dismissed articles, sampling with rank-biased randomness and domain caps.
     */
    async getPopularArticles(
        userId: string,
        limit = 12,
        poolSize = 60,
        previouslyRecommendedIds: string[] = [],
    ): Promise<Article[]> {
        const [userArticles, user] = await Promise.all([
            this.userArticlesService.findAllForUser(userId),
            this.usersService.findById(userId),
        ]);
        const userArticleIds = userArticles
            .map((ua) => ua.articleId)
            .filter((id): id is string => Boolean(id));
        const dismissedArticleIds = user?.dismissedArticleIds ?? [];
        const allExcludedIds = [
            ...new Set([...userArticleIds, ...previouslyRecommendedIds, ...dismissedArticleIds]),
        ];

        const popularPool = await this.articlesService.findPopular(allExcludedIds, poolSize);

        return samplePopularWithDiversity(popularPool, { limit });
    }
}
