import type { Article } from '../articles/entities/article.entity';
import type { RecommendationCandidate } from '../articles/articles.service';

export interface InterestItem {
    id: string;
    title?: string;
    embedding: number[];
    createdAt: string;
    lastReadAt?: string;
    status?: string;
    progressPercentage?: number;
    isLiked: boolean;
    isBookmarked: boolean;
    tagCount: number;
    hasHighlights?: boolean;
    hasChat?: boolean;
    hasSummaryOrAudio?: boolean;
}

export interface InterestCluster {
    centroid: number[];
    totalWeight: number;
    size: number;
}

export interface MergedCandidate {
    article: RecommendationCandidate;
    sourceCluster: number;
    matchedClusterCount: number;
    mergedScore: number;
    adjustedScore: number;
    domain: string;
}

/** Cosine similarity between two equal-length numeric vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
    if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
    let dot = 0;
    let magA = 0;
    let magB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
    }
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom > 0 ? dot / denom : 0;
}

/** Adds `v * weight` to `acc` in-place. */
export function addVector(acc: number[], v: number[], weight = 1): void {
    const len = Math.min(acc.length, v.length);
    for (let i = 0; i < len; i++) {
        acc[i] += v[i] * weight;
    }
}

/** Returns an L2-normalized copy of `v` (or a copy of `v` if zero-norm). */
export function normalizeVector(v: number[]): number[] {
    let sumSq = 0;
    for (let i = 0; i < v.length; i++) {
        sumSq += v[i] * v[i];
    }
    const mag = Math.sqrt(sumSq);
    if (mag === 0) return [...v];
    return v.map((val) => val / mag);
}

/** Extracts a normalized source/domain key for diversity capping & fatigue tracking. */
export function extractDomain(url?: string, siteName?: string): string {
    if (url) {
        try {
            const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
            if (host) return host;
        } catch {
            // Fall through to siteName
        }
    }
    return (siteName || '').trim().toLowerCase();
}

/**
 * Computes the interest weight for a single saved article using:
 * - Exponential time decay (60-day half-life) anchored on max(createdAt, lastReadAt)
 * - Additive engagement signals (likes, bookmarks, tags, reading progress, highlights, chat, summary/audio)
 * - Mild decay for stale unread articles saved > 30 days ago with zero engagement
 */
export function computeItemWeight(item: InterestItem, nowMs = Date.now()): number {
    const createdMs = new Date(item.createdAt).getTime();
    const lastReadMs = item.lastReadAt ? new Date(item.lastReadAt).getTime() : NaN;
    const activityMs = Number.isFinite(lastReadMs) && lastReadMs > createdMs ? lastReadMs : createdMs;
    const daysOld = Number.isFinite(activityMs)
        ? Math.max(0, (nowMs - activityMs) / (1000 * 60 * 60 * 24))
        : 0;

    // 50% weight at ~60 days
    const recencyDecay = Math.exp(-0.0115 * daysOld);

    let engagement = 1.0;
    if (item.isLiked) engagement += 2.0;
    if (item.isBookmarked) engagement += 1.5;
    if (item.tagCount > 0) engagement += Math.min(1.5, 0.75 + 0.25 * item.tagCount);

    const progress = item.progressPercentage ?? 0;
    if (item.status === 'read' || progress >= 80) {
        engagement += 0.75;
    } else if (progress >= 30) {
        engagement += 0.35;
    }

    if (item.hasHighlights) engagement += 0.8;
    if (item.hasChat) engagement += 0.6;
    if (item.hasSummaryOrAudio) engagement += 0.4;

    const isStaleUnread =
        (item.status === 'unread' || !item.status) &&
        progress === 0 &&
        !item.isLiked &&
        !item.isBookmarked &&
        item.tagCount === 0 &&
        !item.hasHighlights &&
        !item.hasChat &&
        daysOld > 30;

    const staleFactor = isStaleUnread ? 0.75 : 1.0;

    return recencyDecay * engagement * staleFactor;
}

/**
 * Computes an L2-normalized weighted centroid and total weight for a set of interest items.
 */
export function calculateWeightedCentroid(
    items: InterestItem[],
    nowMs = Date.now(),
): { centroid: number[]; totalWeight: number } {
    if (items.length === 0) return { centroid: [], totalWeight: 0 };

    const vectorLen = items[0].embedding.length;
    const centroid = new Array<number>(vectorLen).fill(0);
    let totalWeight = 0;

    for (const item of items) {
        const weight = computeItemWeight(item, nowMs);
        addVector(centroid, item.embedding, weight);
        totalWeight += weight;
    }

    if (totalWeight > 0) {
        for (let i = 0; i < vectorLen; i++) {
            centroid[i] /= totalWeight;
        }
    }

    return {
        centroid: normalizeVector(centroid),
        totalWeight,
    };
}

/** Chooses an adaptive target cluster count based on library size. */
export function chooseClusterCount(itemCount: number, maxK = 4): number {
    if (itemCount < 4) return 1;
    if (itemCount < 10) return Math.min(maxK, 2);
    if (itemCount < 25) return Math.min(maxK, 3);
    return maxK;
}

/**
 * Deterministic K-Means++ over article-interest embeddings:
 * 1. Seeds first centroid with the highest-weight item, then iteratively picks
 *    farthest items weighted by sqrt(interestWeight) so distinct topics separate.
 * 2. Iterates up to 10 times with early convergence and drops empty clusters
 *    (preventing undefined-centroid crashes).
 * 3. Merges near-duplicate clusters (centroid cosine similarity >= mergeThreshold).
 * 4. Returns clusters sorted descending by total engagement weight.
 */
export function clusterInterests(
    items: InterestItem[],
    options: { maxK?: number; mergeThreshold?: number; maxIterations?: number; nowMs?: number } = {},
): InterestCluster[] {
    if (items.length === 0) return [];

    const { maxK = 4, mergeThreshold = 0.85, maxIterations = 10, nowMs = Date.now() } = options;
    const targetK = Math.min(items.length, chooseClusterCount(items.length, maxK));

    if (targetK <= 1) {
        const { centroid, totalWeight } = calculateWeightedCentroid(items, nowMs);
        return [{ centroid, totalWeight, size: items.length }];
    }

    const weights = items.map((item) => computeItemWeight(item, nowMs));

    // Deterministic K-Means++ seeding
    const seedIndices: number[] = [];
    let firstIdx = 0;
    for (let i = 1; i < items.length; i++) {
        if (weights[i] > weights[firstIdx]) firstIdx = i;
    }
    seedIndices.push(firstIdx);

    while (seedIndices.length < targetK) {
        let bestIdx = -1;
        let bestScore = -1;

        for (let i = 0; i < items.length; i++) {
            if (seedIndices.includes(i)) continue;
            let maxSim = -1;
            for (const sIdx of seedIndices) {
                const sim = cosineSimilarity(items[i].embedding, items[sIdx].embedding);
                if (sim > maxSim) maxSim = sim;
            }
            const distance = Math.max(0, 1 - maxSim);
            const score = distance * Math.sqrt(Math.max(weights[i], 1e-6));
            if (score > bestScore) {
                bestScore = score;
                bestIdx = i;
            }
        }

        if (bestIdx === -1 || bestScore <= 1e-6) break;
        seedIndices.push(bestIdx);
    }

    let centroids = seedIndices.map((idx) => normalizeVector(items[idx].embedding));
    let clusterMemberIndices: number[][] = [];
    let prevAssignments: number[] = [];

    for (let iter = 0; iter < maxIterations; iter++) {
        const assignments: number[][] = centroids.map(() => []);
        const currentAssignments = new Array<number>(items.length);

        for (let i = 0; i < items.length; i++) {
            let bestCluster = 0;
            let maxSim = -Infinity;
            for (let cIdx = 0; cIdx < centroids.length; cIdx++) {
                const sim = cosineSimilarity(items[i].embedding, centroids[cIdx]);
                if (sim > maxSim) {
                    maxSim = sim;
                    bestCluster = cIdx;
                }
            }
            assignments[bestCluster].push(i);
            currentAssignments[i] = bestCluster;
        }

        // Drop empty clusters cleanly rather than keeping stale/undefined centroids.
        const nonEmptyAssignments = assignments.filter((indices) => indices.length > 0);
        centroids = nonEmptyAssignments.map((indices) => {
            const clusterItems = indices.map((i) => items[i]);
            return calculateWeightedCentroid(clusterItems, nowMs).centroid;
        });
        clusterMemberIndices = nonEmptyAssignments;

        const converged =
            prevAssignments.length === currentAssignments.length &&
            currentAssignments.every((val, idx) => val === prevAssignments[idx]);
        if (converged) break;
        prevAssignments = currentAssignments;
    }

    // Build initial cluster groups and merge any near-duplicate clusters.
    let groups = clusterMemberIndices.map((indices) => {
        const groupItems = indices.map((i) => items[i]);
        const { centroid, totalWeight } = calculateWeightedCentroid(groupItems, nowMs);
        return { indices, centroid, totalWeight };
    });

    let merged = true;
    while (merged && groups.length > 1) {
        merged = false;
        let bestPair: [number, number] | null = null;
        let bestSim = mergeThreshold;

        for (let i = 0; i < groups.length; i++) {
            for (let j = i + 1; j < groups.length; j++) {
                const sim = cosineSimilarity(groups[i].centroid, groups[j].centroid);
                if (sim >= bestSim) {
                    bestSim = sim;
                    bestPair = [i, j];
                }
            }
        }

        if (bestPair) {
            const [i, j] = bestPair;
            const combinedIndices = [...groups[i].indices, ...groups[j].indices];
            const combinedItems = combinedIndices.map((idx) => items[idx]);
            const { centroid, totalWeight } = calculateWeightedCentroid(combinedItems, nowMs);
            groups[i] = { indices: combinedIndices, centroid, totalWeight };
            groups.splice(j, 1);
            merged = true;
        }
    }

    return groups
        .map((g) => ({
            centroid: g.centroid,
            totalWeight: g.totalWeight,
            size: g.indices.length,
        }))
        .sort((a, b) => b.totalWeight - a.totalWeight);
}

/**
 * Allocates candidate retrieval budgets across clusters proportionally to
 * each cluster's engagement weight while ensuring every cluster gets a floor.
 */
export function allocateClusterBudgets(
    clusters: InterestCluster[],
    poolSize: number,
    minPerCluster = 8,
): number[] {
    if (clusters.length === 0) return [];
    const totalWeight = clusters.reduce((sum, c) => sum + Math.max(c.totalWeight, 0), 0);

    return clusters.map((cluster) => {
        const share = totalWeight > 0 ? cluster.totalWeight / totalWeight : 1 / clusters.length;
        return Math.max(minPerCluster, Math.ceil(poolSize * share));
    });
}

/**
 * Merges candidates retrieved from each cluster, keeping the highest score per
 * article ID (never overwriting a stronger match), applying a subtle cluster
 * importance factor and a small multi-interest bridge bonus when an article
 * matches more than one cluster.
 */
export function mergeClusterCandidates(
    clusterResults: RecommendationCandidate[][],
    clusters: InterestCluster[],
): MergedCandidate[] {
    const maxClusterWeight = Math.max(...clusters.map((c) => c.totalWeight), 1e-6);

    const byId = new Map<
        string,
        {
            article: RecommendationCandidate;
            bestCluster: number;
            bestRawScore: number;
            matchedClusters: Set<number>;
        }
    >();

    clusterResults.forEach((candidates, clusterIdx) => {
        for (const candidate of candidates) {
            const existing = byId.get(candidate.id);
            if (!existing) {
                byId.set(candidate.id, {
                    article: candidate,
                    bestCluster: clusterIdx,
                    bestRawScore: candidate.weightedScore,
                    matchedClusters: new Set([clusterIdx]),
                });
            } else {
                existing.matchedClusters.add(clusterIdx);
                if (candidate.weightedScore > existing.bestRawScore) {
                    existing.article = candidate;
                    existing.bestCluster = clusterIdx;
                    existing.bestRawScore = candidate.weightedScore;
                }
            }
        }
    });

    const merged: MergedCandidate[] = [];
    for (const entry of byId.values()) {
        const clusterWeight = clusters[entry.bestCluster]?.totalWeight ?? maxClusterWeight;
        const clusterMultiplier = 0.9 + 0.1 * (clusterWeight / maxClusterWeight);
        const bridgeBonus = Math.min(0.08, 0.04 * (entry.matchedClusters.size - 1));
        const mergedScore = entry.bestRawScore * clusterMultiplier + bridgeBonus;

        merged.push({
            article: entry.article,
            sourceCluster: entry.bestCluster,
            matchedClusterCount: entry.matchedClusters.size,
            mergedScore,
            adjustedScore: mergedScore,
            domain: extractDomain(entry.article.url, entry.article.siteName),
        });
    }

    return merged;
}

/**
 * Applies targeted per-candidate penalties for dismissed content instead of
 * distorting every interest centroid globally:
 * - Only penalizes candidates whose cosine similarity to a specific dismissed
 *   article exceeds `similarityThreshold` (default 0.65).
 * - Applies mild domain-level fatigue when a user has dismissed >= 2 articles
 *   from the same source.
 */
export function applyDismissalPenalties(
    candidates: MergedCandidate[],
    dismissedEmbeddings: number[][],
    dismissedDomainCounts: Map<string, number> = new Map(),
    similarityThreshold = 0.65,
): MergedCandidate[] {
    if (dismissedEmbeddings.length === 0 && dismissedDomainCounts.size === 0) {
        return candidates;
    }

    const totalDismissed = dismissedEmbeddings.length;

    return candidates.map((candidate) => {
        let simPenalty = 1.0;

        if (candidate.article.embeddingVector && totalDismissed > 0) {
            let maxEffectiveSim = 0;
            for (let i = 0; i < totalDismissed; i++) {
                // dismissedEmbeddings are oldest -> newest; weight recent dismissals slightly higher (0.8..1.0)
                const recencyFactor = totalDismissed > 1 ? 0.8 + 0.2 * (i / (totalDismissed - 1)) : 1.0;
                const sim = cosineSimilarity(candidate.article.embeddingVector, dismissedEmbeddings[i]);
                const effectiveSim = sim * recencyFactor;
                if (effectiveSim > maxEffectiveSim) {
                    maxEffectiveSim = effectiveSim;
                }
            }

            if (maxEffectiveSim > similarityThreshold) {
                const excess = (maxEffectiveSim - similarityThreshold) / (1 - similarityThreshold);
                simPenalty = 1 - Math.min(0.85, excess * 0.85);
            }
        }

        let domainPenalty = 1.0;
        if (candidate.domain) {
            const domainDismissals = dismissedDomainCounts.get(candidate.domain) ?? 0;
            if (domainDismissals >= 3) {
                domainPenalty = 0.7;
            } else if (domainDismissals === 2) {
                domainPenalty = 0.85;
            }
        }

        return {
            ...candidate,
            adjustedScore: candidate.mergedScore * simPenalty * domainPenalty,
        };
    });
}

/**
 * Greedy Maximal Marginal Relevance (MMR) re-ranking with domain capping and
 * cluster-saturation damping so recommendations stay relevant while covering
 * distinct stories, sources, and interest clusters.
 */
export function rerankWithDiversity(
    candidates: MergedCandidate[],
    options: { limit: number; lambda?: number; maxPerDomain?: number; clusterDamping?: number },
): MergedCandidate[] {
    const { limit, lambda = 0.78, maxPerDomain = 2, clusterDamping = 0.93 } = options;
    if (candidates.length === 0 || limit <= 0) return [];

    const remaining = [...candidates];
    const selected: MergedCandidate[] = [];
    const domainCounts = new Map<string, number>();
    const clusterCounts = new Map<number, number>();

    while (selected.length < limit && remaining.length > 0) {
        const hasUnderCapDomain = remaining.some(
            (c) => !c.domain || (domainCounts.get(c.domain) ?? 0) < maxPerDomain,
        );

        let bestIdx = 0;
        let bestMmrScore = -Infinity;

        for (let i = 0; i < remaining.length; i++) {
            const candidate = remaining[i];
            const domainCount = candidate.domain ? (domainCounts.get(candidate.domain) ?? 0) : 0;
            const isOverDomainCap = Boolean(candidate.domain) && domainCount >= maxPerDomain;

            if (hasUnderCapDomain && isOverDomainCap) {
                continue;
            }

            let maxSimToSelected = 0;
            if (candidate.article.embeddingVector && selected.length > 0) {
                for (const picked of selected) {
                    if (!picked.article.embeddingVector) continue;
                    const sim = cosineSimilarity(
                        candidate.article.embeddingVector,
                        picked.article.embeddingVector,
                    );
                    if (sim > maxSimToSelected) {
                        maxSimToSelected = sim;
                    }
                }
            }

            const sameClusterCount = clusterCounts.get(candidate.sourceCluster) ?? 0;
            const dampedRelevance =
                candidate.adjustedScore *
                Math.pow(clusterDamping, sameClusterCount) *
                (isOverDomainCap ? 0.7 : 1.0);

            // Strongly demote near-duplicate coverage of the exact same story.
            const nearDuplicatePenalty = maxSimToSelected > 0.92 ? 0.35 : 0;
            const mmrScore =
                lambda * dampedRelevance - (1 - lambda) * maxSimToSelected - nearDuplicatePenalty;

            if (mmrScore > bestMmrScore) {
                bestMmrScore = mmrScore;
                bestIdx = i;
            }
        }

        const [chosen] = remaining.splice(bestIdx, 1);
        selected.push(chosen);
        if (chosen.domain) {
            domainCounts.set(chosen.domain, (domainCounts.get(chosen.domain) ?? 0) + 1);
        }
        clusterCounts.set(chosen.sourceCluster, (clusterCounts.get(chosen.sourceCluster) ?? 0) + 1);
    }

    return selected;
}

/**
 * Samples from a rank-ordered popular pool with rank-biased randomness (so top
 * articles appear more often than the tail while still refreshing) and enforces
 * a per-domain cap for source variety.
 */
export function samplePopularWithDiversity(
    pool: Article[],
    options: { limit: number; maxPerDomain?: number; rng?: () => number },
): Article[] {
    const { limit, maxPerDomain = 2, rng = Math.random } = options;
    if (pool.length === 0 || limit <= 0) return [];

    const scored = pool.map((article, idx) => ({
        article,
        domain: extractDomain(article.url, article.siteName),
        rankScore: (1 / Math.pow(idx + 1, 0.45)) * (0.6 + 0.4 * rng()),
    }));
    scored.sort((a, b) => b.rankScore - a.rankScore);

    const selected: Article[] = [];
    const overflow: Article[] = [];
    const domainCounts = new Map<string, number>();

    for (const item of scored) {
        if (selected.length >= limit) break;
        const count = item.domain ? (domainCounts.get(item.domain) ?? 0) : 0;
        if (!item.domain || count < maxPerDomain) {
            selected.push(item.article);
            if (item.domain) domainCounts.set(item.domain, count + 1);
        } else {
            overflow.push(item.article);
        }
    }

    for (const article of overflow) {
        if (selected.length >= limit) break;
        selected.push(article);
    }

    return selected;
}
