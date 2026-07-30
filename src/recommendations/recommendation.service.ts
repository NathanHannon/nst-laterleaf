import { Injectable } from '@nestjs/common';
import { Article } from '../articles/entities/article.entity';
import { ArticlesService } from '../articles/articles.service';
import { UserArticlesService } from '../articles/user-articles.service';
import { UsersService } from '../users/users.service';
import { UserArticleTagsService } from '../tags/user-article-tags.service';

interface ScoredArticle extends Article {
    weightedScore?: number;
    sourceCluster?: number;
}

interface InterestItem {
    id: string;
    title?: string;
    embedding: number[];
    createdAt: string;
    isTagged: boolean;
    isLiked: boolean;
}

/** Cosine similarity between two equal-length numeric vectors. */
function cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0;
    let magA = 0;
    let magB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
    }
    return dot / (Math.sqrt(magA) * Math.sqrt(magB) || 1);
}

/** Adds `v * weight` to `acc` in-place. */
function addVector(acc: number[], v: number[], weight = 1): void {
    for (let i = 0; i < acc.length; i++) {
        acc[i] += v[i] * weight;
    }
}

/** Fisher-Yates shuffle (mutates and returns the same array). */
function shuffleArray<T>(array: T[]): T[] {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

/**
 * personalized article recommendations via a hybrid approach: interest
 * clustering over a user's saved-article embeddings (K-Means with time
 * decay + like/tag boosts + a negative signal from dismissed articles),
 * then a weighted (60% semantic / 30% bookmarks / 10% saves) pgvector
 * similarity search per cluster. Falls back to popularity-based
 * recommendations if the user has too little history or on any error.
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
            // 1. Fetch user's saved-article links.
            const userArticles = await this.userArticlesService.findAllForUser(userId);
            if (userArticles.length === 0) return [];

            const userArticleMap = new Map(userArticles.map((ua) => [ua.articleId, ua]));
            const userArticleIds = Array.from(userArticleMap.keys()).filter((id): id is string => typeof id === 'string');

            // 1b. Fetch dismissed article ids from the user profile.
            const user = await this.usersService.findById(userId);
            const dismissedArticleIds = user?.dismissedArticleIds ?? [];

            // 2. Fetch embeddings + titles for the user's saved articles.
            const embeddingMap = await this.articlesService.getEmbeddingsForIds(userArticleIds);
            const articleRows = await this.articlesService.findByIds(userArticleIds);
            const titleById = new Map(articleRows.map((a) => [a.id, a.title]));

            // 2b. Fetch tagged UserArticle ids — explicit interest signals.
            const userArticleIdsForTags = Array.from(userArticleMap.values())
                .map((ua) => ua.id)
                .filter((id): id is string => Boolean(id));
            const taggedRecords = await this.userArticleTagsService.findByUserArticleIds(userArticleIdsForTags);
            const taggedUserArticleIds = new Set(taggedRecords.map((t) => t.userArticleId));
            const taggedArticleIds = new Set(
                Array.from(userArticleMap.values())
                    .filter((ua) => ua.id && taggedUserArticleIds.has(ua.id))
                    .map((ua) => ua.articleId)
                    .filter((id): id is string => typeof id === 'string'),
            );

            const validItems: InterestItem[] = userArticleIds
                .filter((id) => embeddingMap.has(id))
                .map((id) => {
                    const ua = userArticleMap.get(id);
                    return {
                        id,
                        title: titleById.get(id),
                        embedding: embeddingMap.get(id) as number[],
                        createdAt: (ua?.createdAt ? new Date(ua.createdAt) : new Date()).toISOString(),
                        isTagged: taggedArticleIds.has(id),
                        isLiked: ua?.isLiked || false,
                    };
                });

            if (validItems.length === 0) {
                return this.getPopularArticles(userId, limit, poolSize, previouslyRecommendedIds);
            }

            // 3. Generate interest clusters: single weighted centroid if the
            // user has < 5 articles, otherwise up to 3 K-Means clusters.
            let clusters = validItems.length < 5
                ? [this.calculateWeightedCentroid(validItems)]
                : this.clusterInterests(validItems, 3);

            // 3b. Apply a negative signal from dismissed articles, nudging
            // centroids away from content the user explicitly rejected.
            if (dismissedArticleIds.length > 0) {
                const dismissedEmbeddingMap = await this.articlesService.getEmbeddingsForIds(dismissedArticleIds);
                const dismissedEmbeddings = Array.from(dismissedEmbeddingMap.values());

                if (dismissedEmbeddings.length > 0) {
                    const negativeCenter = new Array(dismissedEmbeddings[0].length).fill(0);
                    for (const emb of dismissedEmbeddings) {
                        addVector(negativeCenter, emb);
                    }
                    for (let i = 0; i < negativeCenter.length; i++) {
                        negativeCenter[i] /= dismissedEmbeddings.length;
                    }

                    // Scale: 0.15 per dismissed article, capped at 0.6 to avoid over-correction.
                    const negativeWeight = Math.min(0.15 * dismissedEmbeddings.length, 0.6);
                    clusters = clusters.map((centroid) => {
                        const adjusted = [...centroid];
                        addVector(adjusted, negativeCenter, -negativeWeight);
                        const magnitude = Math.sqrt(adjusted.reduce((sum, v) => sum + v * v, 0)) || 1;
                        return adjusted.map((v) => v / magnitude);
                    });
                }
            }

            // 4. Parallel similarity search per cluster, excluding saved,
            // previously-recommended, and dismissed articles.
            const allExcludedIds = [...new Set([...userArticleIds, ...previouslyRecommendedIds, ...dismissedArticleIds])];
            const itemsPerCluster = Math.ceil(poolSize / clusters.length);

            const promiseResults = await Promise.all(
                clusters.map((centroid, idx) =>
                    this.articlesService
                        .findSimilarWeighted(centroid, { limit: itemsPerCluster, excludeIds: allExcludedIds })
                        .then((res) => res.map((r) => ({ ...r, sourceCluster: idx }) as ScoredArticle)),
                ),
            );

            // 5. Merge, deduplicate, and rank.
            const mergedResults = promiseResults.flat();
            const uniqueResults = Array.from(new Map(mergedResults.map((item) => [item.id, item])).values());

            const finalRecommendations = uniqueResults
                .sort((a, b) => (b.weightedScore || 0) - (a.weightedScore || 0))
                .slice(0, limit);

            return finalRecommendations.map(({ sourceCluster, weightedScore, ...data }) => data as Article);
        } catch (error) {
            console.error('Error generating recommendations:', error);
            return this.getPopularArticles(userId, limit, poolSize, previouslyRecommendedIds);
        }
    }

    /**
     * Simplified K-Means over article-interest embeddings. Seeds centroids
     * from the most recent articles, then iterates 5 times, re-weighting
     * each cluster's centroid via `calculateWeightedCentroid`.
     */
    private clusterInterests(items: InterestItem[], k: number): number[][] {
        const sortedItems = [...items].sort(
            (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );

        const seeds = sortedItems.slice(0, Math.min(k, Math.floor(sortedItems.length / 2)));
        let centroids = seeds.slice(0, k).map((s) => [...s.embedding]);

        for (let iter = 0; iter < 5; iter++) {
            const assignments: number[][] = Array(k).fill(0).map(() => []);

            items.forEach((item, itemIdx) => {
                let maxSim = -1;
                let bestCluster = 0;
                centroids.forEach((c, cIdx) => {
                    const sim = cosineSimilarity(item.embedding, c);
                    if (sim > maxSim) {
                        maxSim = sim;
                        bestCluster = cIdx;
                    }
                });
                assignments[bestCluster].push(itemIdx);
            });

            centroids = assignments.map((indices, cIdx) => {
                if (indices.length === 0) return centroids[cIdx];
                const clusterItems = indices.map((i) => items[i]);
                return this.calculateWeightedCentroid(clusterItems);
            });
        }

        return centroids;
    }

    /**
     * Weighted centroid of a set of item embeddings, with exponential time
     * decay (50% weight at 60 days) plus 3.5x like-boost / 2.5x tag-boost
     * multipliers for explicit interest signals.
     */
    private calculateWeightedCentroid(
        items: { embedding: number[]; createdAt: string; isTagged?: boolean; isLiked?: boolean }[],
    ): number[] {
        if (items.length === 0) return [];
        const vectorLen = items[0].embedding.length;
        const centroid = new Array(vectorLen).fill(0);
        let totalWeight = 0;

        items.forEach((item) => {
            const daysOld = (Date.now() - new Date(item.createdAt).getTime()) / (1000 * 60 * 60 * 24);
            let weight = Math.exp(-0.0115 * Math.max(0, daysOld));

            if (item.isLiked) weight *= 3.5;
            if (item.isTagged) weight *= 2.5;

            addVector(centroid, item.embedding, weight);
            totalWeight += weight;
        });

        if (totalWeight > 0) {
            for (let i = 0; i < vectorLen; i++) {
                centroid[i] /= totalWeight;
            }
        }

        return centroid;
    }

    /**
     * Popularity-based fallback: 75% weight on bookmarks, 25% on saves.
     */
    async getPopularArticles(
        userId: string,
        limit = 12,
        poolSize = 60,
        previouslyRecommendedIds: string[] = [],
    ): Promise<Article[]> {
        const userArticles = await this.userArticlesService.findAllForUser(userId);
        const userArticleIds = userArticles.map((ua) => ua.articleId).filter((id): id is string => Boolean(id));
        const allExcludedIds = [...new Set([...userArticleIds, ...previouslyRecommendedIds])];

        const popularPool = await this.articlesService.findPopular(allExcludedIds, poolSize);

        return shuffleArray(popularPool).slice(0, limit);
    }
}
