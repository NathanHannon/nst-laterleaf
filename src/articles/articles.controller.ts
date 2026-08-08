import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    ForbiddenException,
    Get,
    HttpException,
    HttpStatus,
    InternalServerErrorException,
    NotFoundException,
    Param,
    Patch,
    Post,
    Put,
    Query,
    Res,
    ServiceUnavailableException,
    UnauthorizedException,
    UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { FindOptionsWhere } from 'typeorm';
import { ClerkAuthGuard } from '../auth/guards/clerk-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { ClerkUserProfile } from '../auth/interfaces/clerk-user-profile.interface';
import { UsersService } from '../users/users.service';
import { User } from '../users/entities/user.entity';
import { ArticlesService } from './articles.service';
import { UserArticlesService } from './user-articles.service';
import { ArticleChunksService } from './article-chunks.service';
import { Article } from './entities/article.entity';
import { UserArticle } from './entities/user-article.entity';
import { ContentExtractionService } from '../content-extraction/content-extraction.service';
import { MetadataScrapingService } from '../content-extraction/metadata-scraping.service';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { StorageService } from '../storage/storage.service';
import { GenAiService } from '../genai/gen-ai.service';
import { JobQueueService } from '../jobs/job-queue.service';
import { UrlNormalizer } from '../common/url-normalizer';
import { GEMINI_MODELS, OPENAI_MODELS } from '../genai/constants/ai-models';
import type { GenerationProviderName } from '../genai/providers/generation-provider.interface';

type ArticleWithStatus = Partial<Article> & {
    isBookmarked: boolean;
    isLiked: boolean;
    isArchived: boolean;
    userArticleId?: string;
    summary?: string;
    summaryStatus?: string;
    summaryLanguage?: string;
    isUrlOnly?: boolean;
    hasContent?: boolean;
    audioLocation?: string;
};

const PAYWALL_NOTICE = (url: string) => `
  <div class="paywall-notice" style="padding: 2rem; text-align: center; background: var(--card-bg); border-radius: 8px; margin: 2rem 0;">
    <h3>Publisher Restriction</h3>
    <p>We detected that you do not have access to the full content of this article on the publisher's site.</p>
    <p>To respect copyright and paywalls, we cannot display the full content here.</p>
    <p><a href="${url}" target="_blank" rel="noopener noreferrer" style="display: inline-block; margin-top: 1rem; padding: 0.5rem 1rem; background: var(--primary-color); color: white; text-decoration: none; border-radius: 4px;">View on Publisher Site</a></p>
  </div>`;

/**
 *
 * `POST /articles/import` currently performs live extraction. The
 * pre-fetched HTML optimization used by feed ingestion is intentionally
 * handled in feed-domain services rather than this controller.
 */
@UseGuards(ClerkAuthGuard)
@Controller('articles')
export class ArticlesController {
    constructor(
        private readonly articlesService: ArticlesService,
        private readonly userArticlesService: UserArticlesService,
        private readonly articleChunksService: ArticleChunksService,
        private readonly usersService: UsersService,
        private readonly contentExtractionService: ContentExtractionService,
        private readonly metadataScrapingService: MetadataScrapingService,
        private readonly contentModerationService: ContentModerationService,
        private readonly storageService: StorageService,
        private readonly genAiService: GenAiService,
        private readonly jobQueueService: JobQueueService,
        private readonly configService: ConfigService,
    ) { }

    private resolveAdminProviderOverride(
        currentUser: ClerkUserProfile,
        provider?: string,
    ): GenerationProviderName | undefined {
        if (!provider) return undefined;
        if (provider !== 'gemini' && provider !== 'openai-compatible') {
            throw new BadRequestException('Unsupported generation provider');
        }

        const adminClerkIds = this.configService
            .get<string>('ADMIN_CLERK_IDS')
            ?.split(',')
            .map((id) => id.trim());
        const isAdmin = adminClerkIds?.includes(currentUser.clerkId) || currentUser.publicMetadata?.role === 'admin';
        if (!isAdmin) {
            throw new ForbiddenException('Provider override is restricted to admins');
        }
        return provider;
    }

    private async getUserId(currentUser: ClerkUserProfile): Promise<string> {
        const user = await this.usersService.findByClerkId(currentUser.clerkId);
        if (!user?.id) {
            throw new UnauthorizedException('User not found.');
        }
        return user.id;
    }

    /**
     * Resolves the UserArticle link for a given route param `id`, which may
     * either be a real article id or a `url-only-{userArticleId}` pseudo-id
     * used for entries where content extraction failed.
     */
    private async resolveUserArticle(
        id: string,
        userId: string,
    ): Promise<{ userArticle: UserArticle; isUrlOnlyEntry: boolean }> {
        if (id.startsWith('url-only-')) {
            const userArticleId = id.replace('url-only-', '');
            const userArticle = await this.userArticlesService.findById(userArticleId);
            if (!userArticle || userArticle.userId !== userId) {
                throw new NotFoundException('Article not found for this user.');
            }
            return { userArticle, isUrlOnlyEntry: true };
        }

        const userArticle = await this.userArticlesService.findByUserAndArticle(userId, id);
        if (!userArticle) {
            throw new NotFoundException('Article not found for this user.');
        }
        return { userArticle, isUrlOnlyEntry: false };
    }

    /**
     * Resolves the full authenticated user + Pro-access + tier metadata,
     * mirroring `ArticleController.getAuthenticatedUser` in lb-laterleaf.
     * The database's `isPro` flag is the source of truth; an admin role in
     * Clerk's publicMetadata is an override.
     */
    private async getAuthContext(currentUser: ClerkUserProfile): Promise<{
        user: User;
        hasProAccess: boolean;
        metadata: {
            tier: 'pro' | 'free';
            pla: string;
            features: string[];
            accessReason: string;
            rawToken: Record<string, unknown>;
        };
    }> {
        const user = await this.usersService.findByClerkId(currentUser.clerkId);
        if (!user?.id) {
            throw new UnauthorizedException('User not found.');
        }

        const publicMetadata = currentUser.publicMetadata || {};
        const rawToken = currentUser.rawToken || {};
        const plaField = (rawToken.pla as string) || 'u:free_user';
        const features = publicMetadata.features || [];

        const hasProAccess = user.isPro || publicMetadata.role === 'admin';
        const accessReason = user.isPro
            ? 'database: isPro=true'
            : publicMetadata.role === 'admin'
                ? 'admin role override'
                : 'not pro';

        const tier: 'pro' | 'free' = hasProAccess ? 'pro' : 'free';

        return {
            user,
            hasProAccess,
            metadata: { tier, pla: plaField, features, accessReason, rawToken },
        };
    }

    /**
     * Checks and increments monthly credit usage for free-tier users.
     * Pro users have unlimited access. Mirrors
     * `ArticleController.checkAndUpdateCredits` in lb-laterleaf.
     */
    private async checkAndUpdateCredits(
        user: User,
        metadata: { tier: 'pro' | 'free' },
        isProSummary: boolean,
    ): Promise<void> {
        const BASIC_CREDITS_LIMIT = -1; // Unlimited basic summaries per month
        const PRO_CREDITS_LIMIT = 5; // Free users get 5 pro summaries per month as a taste

        const userTier = metadata.tier || 'free';

        const now = new Date();
        const resetDate = new Date(user.creditsResetAt);
        const daysSinceReset = Math.floor((now.getTime() - resetDate.getTime()) / (1000 * 60 * 60 * 24));

        if (daysSinceReset >= 30) {
            user.basicCreditsUsed = 0;
            user.proCreditsUsed = 0;
            user.creditsResetAt = now;
            await this.usersService.save(user);
        }

        if (userTier === 'pro') {
            return;
        }

        if (isProSummary) {
            if (user.proCreditsUsed >= PRO_CREDITS_LIMIT) {
                throw new BadRequestException(
                    `You've used all ${PRO_CREDITS_LIMIT} pro summary credits this month. Upgrade to Pro for unlimited access.`,
                );
            }
            user.proCreditsUsed += 1;
        } else {
            if (BASIC_CREDITS_LIMIT !== -1 && user.basicCreditsUsed >= BASIC_CREDITS_LIMIT) {
                throw new BadRequestException(
                    `You've used all ${BASIC_CREDITS_LIMIT} summary credits this month. Upgrade to Pro for unlimited access.`,
                );
            }
            user.basicCreditsUsed += 1;
        }

        await this.usersService.save(user);
    }

    /**
     * Offloads chunking + embedding of an article's content to the
     * background queue (article-chunking). Mirrors
     * `ArticleController.chunkAndSaveArticle`.
     */
    private async chunkAndSaveArticle(article: Article): Promise<void> {
        if (!article.content || !article.id) return;

        try {
            await this.jobQueueService.addChunkingJob({ articleId: article.id });
        } catch (error) {
            console.error(`❌ Failed to add chunking job for article ${article.id}`, error);
        }
    }

    /**
     * Heuristic paywall detector: domain whitelist, keyword scan, then
     * class/id scan. Mirrors `ArticleController.detectPaywall`.
     */
    private detectPaywall(content: string | undefined, contentHtml: string | undefined, url?: string): boolean {
        if (url) {
            const safeDomains = ['blog.google', 'google.com', 'youtube.com', 'wikipedia.org', 'github.com'];
            try {
                const hostname = new URL(url).hostname;
                if (safeDomains.some((domain) => hostname === domain || hostname.endsWith('.' + domain))) {
                    return false;
                }
            } catch {
                // Ignore invalid URLs
            }
        }

        if (!content) return true;

        const lowerContent = content.toLowerCase();
        const lowerHtml = (contentHtml || '').toLowerCase();

        const paywallKeywords = [
            'subscribe to read',
            'subscription required',
            'sign in to continue',
            'already a subscriber',
            'reached your limit',
            'this article is for subscribers only',
            'unlock this article',
            'start your free trial',
            'to continue reading',
        ];

        for (const keyword of paywallKeywords) {
            if (lowerContent.includes(keyword)) {
                return true;
            }
        }

        const paywallClasses = [
            'paywall',
            'subscription-gate',
            'subscriber-only',
            'premium-content',
            'metered-content',
            'paywall-gate',
        ];

        for (const cls of paywallClasses) {
            if (lowerHtml.includes(`class="${cls}"`) || lowerHtml.includes(`id="${cls}"`)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Retroactively links any URL-only UserArticle entries (failed
     * extractions) that normalize to the same URL as a newly-extracted
     * article. Mirrors `ArticleController.upgradeUrlOnlyEntries`.
     */
    private async upgradeUrlOnlyEntries(normalizedUrl: string, articleId: string): Promise<void> {
        try {
            const allUrlOnlyEntries = await this.userArticlesService.findUrlOnlyEntries();

            const matchingEntries = allUrlOnlyEntries.filter(
                (entry) => entry.originalUrl && UrlNormalizer.normalize(entry.originalUrl) === normalizedUrl,
            );

            if (matchingEntries.length === 0) return;

            const upgradePromises = matchingEntries.map(async (userArticle) => {
                try {
                    await this.userArticlesService.updateById(userArticle.id, {
                        articleId,
                        hasContent: userArticle.hasContent === true,
                    });
                    return userArticle.userId;
                } catch (error) {
                    console.error(`❌ [AUTO-UPGRADE] Failed to upgrade UserArticle ${userArticle.id}:`, error);
                    return null;
                }
            });

            const upgradedUserIds = (await Promise.all(upgradePromises)).filter(Boolean);

            if (upgradedUserIds.length > 0) {
                await this.articlesService.updateSaveCountAtomic(articleId, upgradedUserIds.length);
            }
        } catch (error) {
            console.error(`❌ [AUTO-UPGRADE] Failed to upgrade URL-only entries for ${normalizedUrl}:`, error);
        }
    }

    private isServiceUnavailableError(error: unknown): boolean {
        if (!(error instanceof Error)) return false;

        const errorMessage = error.message.toLowerCase();
        return (
            errorMessage.includes('503') ||
            errorMessage.includes('overloaded') ||
            errorMessage.includes('unavailable') ||
            errorMessage.includes('service_unavailable') ||
            errorMessage.includes('rate limit') ||
            errorMessage.includes('quota')
        );
    }

    private delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /**
     * Generates a summary with exponential backoff, model fallback, and
     * queuing for Pro summaries. Mirrors
     * `ArticleController.generateSummaryWithRetry`.
     */
    private async generateSummaryWithRetry(
        content: string,
        isProSummary: boolean,
        userId: string,
        articleId: string,
        language?: string,
        provider?: GenerationProviderName,
    ): Promise<{
        summary: string;
        model: string;
        status: 'completed' | 'pending';
        fallbackUsed: boolean;
        queuedForRetry: boolean;
    }> {
        // Pro Summaries: queue immediately due to strict rate limits
        if (isProSummary) {
            await this.jobQueueService.addSummaryJob({ articleId, userId, content, isPro: true, language, provider });

            return {
                summary: 'pending',
                model: provider === 'openai-compatible' ? OPENAI_MODELS.PRO_TEXT : GEMINI_MODELS.PRO_TEXT,
                status: 'pending',
                fallbackUsed: false,
                queuedForRetry: true,
            };
        }

        // Basic Summaries: run directly with retry logic
        const maxRetries = 3;
        const baseDelayMs = 1000;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const summary = await this.genAiService.generateSummary(content, false, undefined, language, provider);

                if (summary) {
                    return {
                        summary,
                        model: provider === 'openai-compatible' ? OPENAI_MODELS.FREE_TEXT : GEMINI_MODELS.FREE_TEXT,
                        status: 'completed',
                        fallbackUsed: false,
                        queuedForRetry: false,
                    };
                }

                throw new Error('Primary model returned empty summary');
            } catch (error) {
                const isServiceUnavailable = this.isServiceUnavailableError(error);

                if (!isServiceUnavailable) break;

                if (attempt < maxRetries) {
                    const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
                    await this.delay(delayMs);
                }
            }
        }

        // Fallback model
        try {
            const summary = await this.genAiService.generateSummary(content, false, undefined, language, provider);

            if (summary) {
                return {
                    summary,
                    model: provider === 'openai-compatible' ? OPENAI_MODELS.FREE_TEXT : GEMINI_MODELS.FALLBACK,
                    status: 'completed',
                    fallbackUsed: true,
                    queuedForRetry: false,
                };
            }
        } catch (fallbackError) {
            console.error('❌ Fallback model also failed:', fallbackError);
        }

        return {
            summary: 'pending',
            model: 'failed',
            status: 'pending',
            fallbackUsed: true,
            queuedForRetry: false,
        };
    }

    @Post(':id/bookmark')
    async toggleBookmarkById(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Param('id') id: string,
    ): Promise<void> {
        const userId = await this.getUserId(currentUser);
        const { userArticle, isUrlOnlyEntry } = await this.resolveUserArticle(id, userId);

        const newBookmarkStatus = !userArticle.isBookmarked;
        await this.userArticlesService.updateById(userArticle.id, {
            isBookmarked: newBookmarkStatus,
        });

        if (!isUrlOnlyEntry && userArticle.articleId) {
            await this.articlesService.updateBookmarkCountAtomic(
                userArticle.articleId,
                newBookmarkStatus ? 1 : -1,
            );
        }
    }

    @Post(':id/like')
    async toggleLikeById(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Param('id') id: string,
    ): Promise<void> {
        const userId = await this.getUserId(currentUser);
        const { userArticle } = await this.resolveUserArticle(id, userId);

        await this.userArticlesService.updateById(userArticle.id, {
            isLiked: !userArticle.isLiked,
        });
    }

    /**
     * Saves an already-canonical Article to the current user's library
     * (e.g. from Recommendations). Mirrors `ArticleController.saveToLibrary`.
     */
    @Post(':id/save')
    async saveToLibrary(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Param('id') id: string,
    ): Promise<Article> {
        const userId = await this.getUserId(currentUser);

        const article = await this.articlesService.findById(id);
        if (!article) {
            throw new NotFoundException('Article not found');
        }

        const existingLink = await this.userArticlesService.findByUserAndArticle(userId, id);
        if (existingLink) {
            return article;
        }

        // ACCESS CHECK: re-scrape the URL as the server would see it publicly,
        // so we don't leak paywalled content via the canonical store.
        let hasAccess = false;
        try {
            const freshScrape = await this.contentExtractionService.extractContent(article.url);
            const isPaywalled = this.detectPaywall(freshScrape.content || '', freshScrape.contentHtml || '', article.url);
            hasAccess = !isPaywalled;
        } catch (error) {
            console.error('⚠️ [ACCESS CHECK] Failed to verify access:', error);
            hasAccess = false;
        }

        await this.userArticlesService.create({
            userId,
            articleId: id,
            isBookmarked: false,
            isArchived: false,
            hasContent: hasAccess,
            createdAt: new Date(),
            updatedAt: new Date(),
        });

        // Ensure chunking (just in case it was missed)
        if (article.content) {
            const chunkCount = await this.articleChunksService.countByArticleId(article.id);
            if (chunkCount === 0) {
                this.chunkAndSaveArticle(article).catch((err) => console.error(err));
            }
        }

        return article;
    }

    /**
     * Imports an article by URL: finds/creates the canonical Article
     * (extracting content, moderating, deduping by embedding), then links it
     * to the current user's library. Mirrors `ArticleController.import`.
     */
    @Post('import')
    async import(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Body() body: { url: string },
    ): Promise<{
        success: boolean;
        article?: Article;
        message?: string;
        extractionMethod?: 'static' | 'failed' | 'pre-fetched';
        processingTimeMs?: number;
        moderationDetails?: { saveModeration: { allowed: boolean; reasoning: string }; recommendationModeration: null };
    }> {
        const { url: rawUrl } = body;
        const url = UrlNormalizer.normalize(rawUrl);

        const { user } = await this.getAuthContext(currentUser);
        const userId = user.id;
        let hasContent = true;

        let article = await this.articlesService.findByUrl(url);
        let extractionMethod: 'static' | 'failed' | 'pre-fetched' = 'static';
        let processingTimeMs = 0;

        if (!article) {
            try {
                const extractedData = await this.contentExtractionService.extractContent(url);
                extractionMethod = extractedData.extractionMethod;
                processingTimeMs = extractedData.processingTimeMs;

                if (!extractedData.content) {
                    const existingUserArticle = await this.userArticlesService.findByUserAndOriginalUrl(userId, rawUrl);
                    if (existingUserArticle) {
                        return {
                            success: false,
                            message:
                                "You've already saved this URL to your library, though we couldn't extract its content. You can still access it via the original link.",
                            extractionMethod: 'failed',
                            processingTimeMs,
                        };
                    }

                    await this.userArticlesService.create({ userId, originalUrl: rawUrl, hasContent: false });

                    return {
                        success: false,
                        message:
                            extractedData.excerpt ||
                            "We couldn't extract the content from this website, but we've saved the link to your library. You can access the original article by clicking the link.",
                        extractionMethod: 'failed',
                        processingTimeMs,
                    };
                }

                const [saveModeration, moderationResult, scrapedMetadata] = await Promise.all([
                    this.contentModerationService.moderateForSaving(
                        url,
                        extractedData.title,
                        extractedData.excerpt,
                        extractedData.content,
                        extractedData.imageUrl,
                    ),
                    this.contentModerationService.moderateForRecommendations(
                        url,
                        extractedData.title,
                        extractedData.excerpt,
                        extractedData.content,
                        extractedData.imageUrl,
                    ),
                    this.metadataScrapingService.scrapeMetadata(url),
                ]);

                // Block saving if content contains illegal material or threats.
                // NOTE: like the original lb-laterleaf behavior, this throw is
                // caught by the catch block below and converted into a
                // generic "couldn't extract" URL-only save rather than a
                // hard 400 — this intentionally avoids exposing moderation
                // reasoning to the client while still preventing the
                // canonical Article/embeddings from being created.
                if (saveModeration.shouldBlockSave) {
                    const errorMessage = saveModeration.safeBrowsingThreat
                        ? `This URL has been flagged by Google Safe Browsing as potentially dangerous (${saveModeration.safeBrowsingThreat}). For your security, we cannot save content from this source.`
                        : `This content cannot be saved as it contains material that violates our content policy: ${saveModeration.flaggedCategories.join(', ')}`;
                    throw new Error(errorMessage);
                }

                console.log('🔍 [DEDUP] Generating embedding to check for duplicate content...');
                const contentEmbedding = await this.genAiService.generateEmbeddings(extractedData.content, {
                    purpose: 'article_storage',
                    contextId: url,
                });

                let duplicateArticle: Article | null = null;
                if (contentEmbedding && contentEmbedding.length > 0) {
                    duplicateArticle = await this.articlesService.findDuplicateByEmbedding(contentEmbedding, 0.01);
                }

                if (duplicateArticle) {
                    article = duplicateArticle;
                } else {
                    article = await this.articlesService.create({
                        url,
                        title: scrapedMetadata.title || extractedData.title,
                        content: extractedData.content,
                        contentHtml: extractedData.contentHtml,
                        excerpt: scrapedMetadata.ogDescription || extractedData.excerpt,
                        imageUrl: scrapedMetadata.ogImage || extractedData.imageUrl,
                        author: scrapedMetadata.author,
                        publishDate: scrapedMetadata.publishDate ? new Date(scrapedMetadata.publishDate) : undefined,
                        siteName: scrapedMetadata.siteName,
                        siteIcon: scrapedMetadata.siteIcon,
                        ogImage: scrapedMetadata.ogImage,
                        ogDescription: scrapedMetadata.ogDescription,
                        themeColor: scrapedMetadata.themeColor,
                        ogType: scrapedMetadata.ogType,
                        metadataScrapedAt: new Date(),
                        isEligibleForRecommendation: moderationResult.isEligibleForRecommendation,
                    });

                    if (contentEmbedding && contentEmbedding.length > 0) {
                        await this.articlesService.saveEmbedding(article.id, contentEmbedding);
                    }

                    const isPaywalled = this.detectPaywall(article.content || '', article.contentHtml || '', url);
                    if (isPaywalled) {
                        hasContent = false;
                    }

                    this.chunkAndSaveArticle(article).catch((err) =>
                        console.error(`Error chunking article ${article!.id}:`, err),
                    );
                }

                if (article.id) {
                    this.upgradeUrlOnlyEntries(url, article.id).catch((err) =>
                        console.error('Failed to upgrade URL-only entries', err),
                    );
                }
            } catch (extractionError) {
                console.error('❌ [EXTRACTION] Service failed:', extractionError);

                if (extractionError instanceof Error && extractionError.message.includes('CRITICAL_BLOCK')) {
                    throw new ServiceUnavailableException(
                        'We are currently experiencing high traffic with this content provider. Please try again in a few minutes.',
                    );
                }

                const existingUserArticle = await this.userArticlesService.findByUserAndOriginalUrl(userId, rawUrl);
                if (existingUserArticle) {
                    return {
                        success: false,
                        message:
                            "You've already saved this URL to your library. We're having trouble extracting its content, but you can still access it via the original link.",
                        extractionMethod: 'failed',
                        processingTimeMs,
                    };
                }

                await this.userArticlesService.create({ userId, originalUrl: rawUrl, hasContent: false });

                const errorMessage = extractionError instanceof Error ? extractionError.message : 'Unknown extraction error';
                let friendlyMessage =
                    "We couldn't extract the content from this website, but we've saved the link to your library. You can access the original article by clicking the link.";

                if (errorMessage.includes('timeout') || errorMessage.includes('took too long')) {
                    friendlyMessage =
                        "The website took too long to respond, so we've saved the link to your library instead. You can access the original article by clicking the link.";
                } else if (errorMessage.includes('access') || errorMessage.includes('block') || errorMessage.includes('forbidden')) {
                    friendlyMessage =
                        "This website is blocking our content extraction, but we've saved the link to your library. You can access the original article by clicking the link.";
                } else if (errorMessage.includes('network') || errorMessage.includes('unavailable')) {
                    friendlyMessage =
                        "We couldn't connect to this website right now, but we've saved the link to your library. You can access the original article by clicking the link.";
                }

                return {
                    success: false,
                    message: friendlyMessage,
                    extractionMethod: 'failed',
                    processingTimeMs,
                };
            }
        } else {
            // Article already exists: re-verify public access and ensure it's chunked.
            try {
                const freshScrape = await this.contentExtractionService.extractContent(url);
                const isPaywalled = this.detectPaywall(freshScrape.content || '', freshScrape.contentHtml || '', url);
                hasContent = !isPaywalled;
            } catch (error) {
                console.error('⚠️ [ACCESS CHECK] Failed to verify access:', error);
                hasContent = false;
            }

            if (article.content && article.id) {
                const chunkCount = await this.articleChunksService.countByArticleId(article.id);
                if (chunkCount === 0) {
                    this.chunkAndSaveArticle(article).catch((err) =>
                        console.error(`Error queuing chunking for existing article ${article!.id}:`, err),
                    );
                }
            }
        }

        const userArticleLink = await this.userArticlesService.findByUserAndArticle(userId, article.id);

        if (!userArticleLink) {
            await this.userArticlesService.create({ userId, articleId: article.id, hasContent });
            await this.articlesService.updateSaveCountAtomic(article.id, 1);
        }

        return {
            success: true,
            article,
            extractionMethod,
            processingTimeMs,
            moderationDetails: {
                saveModeration: { allowed: true, reasoning: 'Content passed save moderation checks' },
                recommendationModeration: null,
            },
        };
    }

    /**
     * Creates/updates an article from content already extracted by the
     * browser extension (skips ContentExtractionService entirely — the
     * extension's DOM-based extraction is trusted). Mirrors
     * `ArticleController.createFromExtension`.
     */
    @Post('from-extension')
    async createFromExtension(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Body()
        payload: {
            url: string;
            title: string;
            content: string;
            contentHtml: string;
            excerpt?: string;
            imageUrl?: string;
            author?: string;
            publishedAt?: string;
            siteName?: string;
            hasContent?: boolean;
            metadata?: {
                ogImage?: string;
                ogTitle?: string;
                ogDescription?: string;
                favicon?: string;
            };
        },
    ): Promise<Article> {
        const { user } = await this.getAuthContext(currentUser);
        const normalizedUrl = UrlNormalizer.normalize(payload.url);

        let article = await this.articlesService.findByUrl(normalizedUrl);
        // SECURITY: default to FALSE unless the payload explicitly says true,
        // so malformed/older extension requests don't accidentally grant access.
        let hasContent = payload.hasContent === true;

        if (hasContent && this.detectPaywall(payload.content, payload.contentHtml, normalizedUrl)) {
            hasContent = false;
        }

        // Fail closed for recommendation eligibility: paywalled/unavailable
        // content should never enter recommendation candidates.
        let isEligibleForRecommendation = false;
        if (hasContent) {
            try {
                const saveModeration = await this.contentModerationService.moderateForSaving(
                    normalizedUrl,
                    payload.title,
                    payload.excerpt || '',
                    payload.content,
                    payload.imageUrl || payload.metadata?.ogImage,
                );

                if (saveModeration.shouldBlockSave) {
                    console.warn(
                        `[MODERATION] Extension article blocked for save (${normalizedUrl}): ${saveModeration.reasoning}`,
                    );
                    hasContent = false;
                } else {
                    const moderationResult = await this.contentModerationService.moderateForRecommendations(
                        normalizedUrl,
                        payload.title,
                        payload.excerpt || '',
                        payload.content,
                        payload.imageUrl || payload.metadata?.ogImage,
                    );
                    isEligibleForRecommendation = moderationResult.isEligibleForRecommendation;
                }
            } catch (error) {
                console.error(
                    '[MODERATION] Failed to evaluate extension moderation checks, defaulting to no content and ineligible:',
                    error,
                );
                hasContent = false;
            }
        }

        if (article) {
            if (article.id && article.isEligibleForRecommendation !== isEligibleForRecommendation) {
                await this.articlesService.updateById(article.id, { isEligibleForRecommendation });
                article.isEligibleForRecommendation = isEligibleForRecommendation;
            }

            if (hasContent) {
                // AUTO-UPGRADE: if the existing article is a short snippet (or
                // empty, e.g. previously paywalled) and the new one is much
                // longer, upgrade the canonical content.
                const existingLength = article.content?.length || 0;
                const newLength = payload.content?.length || 0;
                const existingIsEmpty = existingLength < 50;

                if (existingIsEmpty || (newLength > existingLength * 1.5 && newLength > 1000)) {
                    await this.articlesService.updateById(article.id, {
                        content: payload.content,
                        contentHtml: payload.contentHtml,
                        excerpt: article.excerpt || payload.excerpt,
                        imageUrl: article.imageUrl || payload.imageUrl || payload.metadata?.ogImage,
                    });

                    article.content = payload.content;
                    article.contentHtml = payload.contentHtml;

                    if (article.id && article.content) {
                        await this.chunkAndSaveArticle(article);

                        this.genAiService
                            .generateEmbeddings(article.title + '\n' + (article.content || ''), {
                                purpose: 'article_storage',
                                contextId: article.id,
                            })
                            .then((embedding) => {
                                if (embedding && embedding.length > 0 && article!.id) {
                                    this.articlesService.saveEmbedding(article!.id, embedding).catch((err) =>
                                        console.error('Embedding save failed', err),
                                    );
                                }
                            })
                            .catch((err) => console.error('Embedding regeneration failed', err));
                    }
                }
            }
        }

        if (!article) {
            const contentToSave = hasContent ? payload.content : '';
            const contentHtmlToSave = hasContent ? payload.contentHtml : '';

            article = await this.articlesService.create({
                url: normalizedUrl,
                title: payload.title,
                content: contentToSave,
                contentHtml: contentHtmlToSave,
                excerpt: payload.excerpt,
                imageUrl: payload.imageUrl || payload.metadata?.ogImage,
                siteName: payload.siteName || payload.metadata?.ogTitle,
                author: payload.author,
                publishDate: payload.publishedAt ? new Date(payload.publishedAt) : undefined,
                ogImage: payload.metadata?.ogImage,
                ogDescription: payload.metadata?.ogDescription,
                siteIcon: payload.metadata?.favicon,
                isEligibleForRecommendation,
            });

            await this.userArticlesService.create({
                userId: user.id,
                articleId: article.id,
                hasContent,
                createdAt: new Date(),
                updatedAt: new Date(),
            });

            if (article.id && hasContent && article.content) {
                const articleId = article.id;

                this.chunkAndSaveArticle(article).catch((err) => console.error(`Error chunking article ${articleId}:`, err));

                this.genAiService
                    .generateEmbeddings(article.title + '\n' + (article.content || ''), {
                        purpose: 'article_storage',
                        contextId: articleId,
                    })
                    .then((embedding) => {
                        if (embedding && embedding.length > 0) {
                            this.articlesService.saveEmbedding(articleId, embedding).catch((err) =>
                                console.error('Embedding save failed', err),
                            );
                        }
                    })
                    .catch((err) => console.error('Embedding generation failed', err));
            }
        } else {
            await this.articlesService.updateSaveCountAtomic(article.id, 1);

            const existingUserArticle = await this.userArticlesService.findByUserAndArticle(user.id, article.id);
            if (!existingUserArticle) {
                await this.userArticlesService.create({
                    userId: user.id,
                    articleId: article.id,
                    hasContent,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                });
            }
        }

        // AUTO-UPGRADE: link any URL-only entries that match this URL now
        // that we have full content.
        if (article.id) {
            await this.upgradeUrlOnlyEntries(normalizedUrl, article.id);
        }

        const existingLink = await this.userArticlesService.findByUserAndArticle(user.id, article.id);
        if (!existingLink) {
            await this.userArticlesService.create({
                userId: user.id,
                articleId: article.id,
                isBookmarked: false,
                isArchived: false,
                status: 'unread',
                hasContent,
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            await this.articlesService.updateSaveCountAtomic(article.id, 1);
        } else if (hasContent && existingLink.hasContent === false) {
            // If link exists but the user previously lacked access (e.g. was
            // Free and is now Pro/re-saved with access), upgrade it.
            await this.userArticlesService.updateById(existingLink.id, { hasContent: true });
        }

        // Mask content in the response if the user doesn't have access.
        if (!hasContent) {
            article.content = article.excerpt || 'Content restricted by publisher.';
            article.contentHtml = PAYWALL_NOTICE(article.url);
        }

        return article;
    }

    @Get('count')
    async count(@Query('where') where?: string): Promise<{ count: number }> {
        const parsedWhere = where
            ? (JSON.parse(where) as FindOptionsWhere<Article>)
            : undefined;
        return { count: await this.articlesService.count(parsedWhere) };
    }

    @Get()
    async find(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Query('filter') filter?: string,
    ): Promise<Array<ArticleWithStatus | Record<string, unknown>>> {
        const userId = await this.getUserId(currentUser);
        const parsedFilter = filter ? JSON.parse(filter) : undefined;

        const userArticleLinks = await this.userArticlesService.findAllForUser(userId);

        let filteredLinks = userArticleLinks;
        if (parsedFilter?.where && 'isBookmarked' in parsedFilter.where) {
            filteredLinks = filteredLinks.filter(
                (link) => link.isBookmarked === parsedFilter.where.isBookmarked,
            );
        }
        if (parsedFilter?.where && 'isArchived' in parsedFilter.where) {
            filteredLinks = filteredLinks.filter(
                (link) => link.isArchived === parsedFilter.where.isArchived,
            );
        }

        const successfulLinks = filteredLinks.filter((link) => link.articleId);
        const urlOnlyLinks = filteredLinks.filter(
            (link) => !link.articleId && link.originalUrl,
        );

        const articleIds = successfulLinks.map((link) => link.articleId as string);
        const articles = await this.articlesService.findByIds(articleIds);

        const statusMap = new Map<string, UserArticle>();
        successfulLinks.forEach((link) => statusMap.set(link.articleId as string, link));

        const articlesWithStatus = articles.map((article) => {
            const link = statusMap.get(article.id);
            const hasContent = link?.hasContent !== false;

            return {
                ...article,
                content: hasContent ? article.content : article.excerpt || 'Content restricted by publisher.',
                contentHtml: hasContent ? article.contentHtml : PAYWALL_NOTICE(article.url),
                isBookmarked: link?.isBookmarked || false,
                isLiked: link?.isLiked || false,
                isArchived: link?.isArchived || false,
                summary: link?.summary || undefined,
                audioLocation: link?.audioLocation || undefined,
                userArticleId: link?.id,
                hasContent,
            };
        });

        const urlOnlyEntries = urlOnlyLinks.map((link) => ({
            id: `url-only-${link.id}`,
            url: link.originalUrl,
            title: link.originalUrl,
            content: null,
            contentHtml: null,
            excerpt: 'Content extraction failed - click to view original article',
            imageUrl: null,
            createdAt: link.createdAt,
            updatedAt: link.updatedAt,
            isBookmarked: link.isBookmarked || false,
            isLiked: link.isLiked || false,
            isArchived: link.isArchived || false,
            summary: link.summary || undefined,
            audioLocation: link.audioLocation || undefined,
            userArticleId: link.id,
            isUrlOnly: true,
        }));

        const allEntries = [...articlesWithStatus, ...urlOnlyEntries];
        allEntries.sort(
            (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime(),
        );

        return allEntries;
    }

    @Patch()
    async updateAll(
        @Body() article: Partial<Article>,
        @Query('where') where?: string,
    ): Promise<{ count: number }> {
        const parsedWhere = where ? (JSON.parse(where) as FindOptionsWhere<Article>) : {};
        return this.articlesService.updateAll(article, parsedWhere);
    }

    @Get(':id')
    async findById(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Param('id') id: string,
    ): Promise<ArticleWithStatus> {
        const userId = await this.getUserId(currentUser);

        if (id.startsWith('url-only-')) {
            const userArticleId = id.replace('url-only-', '');
            const userArticleLink = await this.userArticlesService.findById(userArticleId);
            if (!userArticleLink || userArticleLink.userId !== userId) {
                throw new NotFoundException('Article not found');
            }

            return {
                id,
                url: userArticleLink.originalUrl,
                title: userArticleLink.originalUrl,
                content: undefined,
                contentHtml: undefined,
                excerpt: 'Content extraction failed - click to view original article',
                imageUrl: undefined,
                createdAt: userArticleLink.createdAt,
                updatedAt: userArticleLink.updatedAt,
                userArticleId: userArticleLink.id,
                isBookmarked: userArticleLink.isBookmarked || false,
                isLiked: userArticleLink.isLiked || false,
                isArchived: userArticleLink.isArchived || false,
                summary: userArticleLink.summary,
                summaryStatus: userArticleLink.summaryStatus,
                summaryLanguage: userArticleLink.summaryLanguage || 'en',
                audioLocation: userArticleLink.audioLocation,
                isUrlOnly: true,
            };
        }

        const userArticleLink = await this.userArticlesService.findByUserAndArticle(userId, id);
        if (!userArticleLink) {
            throw new NotFoundException('Article not found');
        }

        const article = await this.articlesService.findById(id);
        if (!article) {
            throw new NotFoundException('Article data not found');
        }

        const hasContent = userArticleLink.hasContent !== false;

        return {
            ...article,
            id: article.id,
            content: hasContent ? article.content : article.excerpt || 'Content restricted by publisher.',
            contentHtml: hasContent ? article.contentHtml : PAYWALL_NOTICE(article.url),
            userArticleId: userArticleLink.id,
            isBookmarked: userArticleLink.isBookmarked,
            isLiked: userArticleLink.isLiked,
            isArchived: userArticleLink.isArchived,
            summary: userArticleLink.summary,
            summaryStatus: userArticleLink.summaryStatus,
            summaryLanguage: userArticleLink.summaryLanguage || 'en',
            audioLocation: userArticleLink.audioLocation,
            narrationLocation: article.narrationLocation,
            narrationStatus: article.narrationStatus,
            hasContent,
        };
    }

    @Patch(':id')
    async updateById(
        @Param('id') id: string,
        @Body() article: Partial<Article>,
    ): Promise<void> {
        await this.articlesService.updateById(id, article);
    }

    @Put(':id')
    async replaceById(
        @Param('id') id: string,
        @Body() article: Partial<Article>,
    ): Promise<void> {
        await this.articlesService.replaceById(id, article);
    }

    @Post(':id/archive')
    async archiveById(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Param('id') id: string,
    ): Promise<void> {
        const userId = await this.getUserId(currentUser);
        const { userArticle } = await this.resolveUserArticle(id, userId);

        userArticle.isArchived = !userArticle.isArchived;
        await this.userArticlesService.save(userArticle);
    }

    @Delete(':id')
    async deleteById(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Param('id') id: string,
    ): Promise<void> {
        const userId = await this.getUserId(currentUser);
        const { userArticle, isUrlOnlyEntry } = await this.resolveUserArticle(id, userId);

        const wasBookmarked = userArticle.isBookmarked;
        await this.userArticlesService.delete(userArticle);

        if (!isUrlOnlyEntry && userArticle.articleId) {
            await this.articlesService.updateSaveCountAtomic(userArticle.articleId, -1);
            if (wasBookmarked) {
                await this.articlesService.updateBookmarkCountAtomic(userArticle.articleId, -1);
            }
        }
    }

    /**
     * Generates (or returns the cached) AI summary for an article, handling
     * credit checks, Pro-vs-Free model choice, exponential-backoff retries,
     * and Pro-summary queuing. Mirrors `ArticleController.summarizeArticle`.
     */
    @Post(':id/summarize')
    async summarizeArticle(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Param('id') id: string,
        @Query('force') force?: string,
        @Query('usePro') usePro?: string,
        @Query('language') language?: string,
        @Query('provider') provider?: string,
    ): Promise<{
        summary: string;
        model?: string;
        status: 'completed' | 'pending';
        fallbackUsed?: boolean;
        queuedForRetry?: boolean;
    }> {
        const { user, hasProAccess, metadata } = await this.getAuthContext(currentUser);
        const providerOverride = this.resolveAdminProviderOverride(currentUser, provider);
        const forceRegenerate = force === 'true';
        const usePreferPro = usePro === 'true';

        if (id.startsWith('url-only-')) {
            throw new BadRequestException(
                "Cannot generate summary for URL-only entries. The article content extraction failed, so there's no content to summarize.",
            );
        }

        const userArticleLink = await this.userArticlesService.findByUserAndArticle(user.id, id);
        if (!userArticleLink) {
            throw new NotFoundException('Article not found in user library');
        }

        const article = await this.articlesService.findById(id);
        if (!article) {
            throw new NotFoundException('Article content not found');
        }

        const currentLanguage = userArticleLink.summaryLanguage || 'en';
        const isLanguageMismatch = !!language && language.toLowerCase() !== currentLanguage.toLowerCase();

        if (
            userArticleLink.summary &&
            !forceRegenerate &&
            !isLanguageMismatch &&
            userArticleLink.summaryStatus !== 'pending'
        ) {
            return { summary: userArticleLink.summary, status: 'completed' };
        }

        const isGeneratingProSummary = hasProAccess || usePreferPro;
        await this.checkAndUpdateCredits(user, metadata, isGeneratingProSummary);

        try {
            await this.userArticlesService.updateById(userArticleLink.id, { summaryStatus: 'pending' });

            const result = await this.generateSummaryWithRetry(
                article.content || '',
                isGeneratingProSummary,
                user.id,
                id,
                language,
                providerOverride,
            );

            if (result.status === 'completed') {
                await this.userArticlesService.updateById(userArticleLink.id, {
                    summary: result.summary,
                    summaryStatus: 'completed',
                    summaryLanguage: language || 'en',
                });
            }

            return result;
        } catch (error) {
            try {
                await this.userArticlesService.updateById(userArticleLink.id, { summaryStatus: 'failed' });
            } catch (revertError) {
                console.error('❌ Failed to update status to failed:', revertError);
            }
            throw error;
        }
    }

    @Delete(':id/summary')
    async deleteSummary(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Param('id') id: string,
    ): Promise<void> {
        const { user } = await this.getAuthContext(currentUser);

        const userArticleLink = await this.userArticlesService.findByUserAndArticle(user.id, id);
        if (!userArticleLink) {
            throw new NotFoundException('Article not found in user library');
        }

        userArticleLink.summary = '';
        await this.userArticlesService.save(userArticleLink);
    }

    /**
     * Generates (or redirects to cached) full-article narration audio via
     * Google Cloud TTS. Mirrors `ArticleController.generateArticleAudio`.
     */
    @Get(':id/audio')
    async generateArticleAudio(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Param('id') id: string,
        @Res({ passthrough: false }) res: Response,
        @Query('voice') voice?: 'Puck' | 'Charon' | 'Kore' | 'Fenrir',
        @Query('speed') speed?: string,
    ): Promise<void> {
        const { hasProAccess } = await this.getAuthContext(currentUser);
        const parsedSpeed = speed ? parseFloat(speed) : undefined;

        if (id.startsWith('url-only-')) {
            throw new BadRequestException(
                "Cannot generate audio for URL-only entries. The article content extraction failed, so there's no content to read.",
            );
        }

        const article = await this.articlesService.findById(id);
        if (!article?.content) {
            throw new NotFoundException('Article content not found or is empty.');
        }

        if (article.narrationLocation && article.narrationStatus === 'completed') {
            res.redirect(article.narrationLocation);
            return;
        }

        let finalAudioUrl = await this.storageService.checkAudioExists(id, 'global', 'single', {
            voice,
            speed: parsedSpeed,
        });

        if (finalAudioUrl) {
            await this.articlesService.updateById(id, {
                narrationLocation: finalAudioUrl,
                narrationStatus: 'completed',
            });
            res.redirect(finalAudioUrl);
            return;
        }

        const { audioBuffer, format } = await this.genAiService.generateSpeech(article.content, hasProAccess, {
            voice,
            speed: parsedSpeed,
        });

        try {
            finalAudioUrl = await this.storageService.uploadAudio(id, audioBuffer, 'global', 'single', {
                format,
                voice,
                speed: parsedSpeed,
            });

            await this.articlesService.updateById(id, {
                narrationLocation: finalAudioUrl,
                narrationStatus: 'completed',
            });
        } catch (error) {
            console.error('⚠️ Failed to save single-speaker audio to R2:', error);
            await this.articlesService.updateById(id, { narrationStatus: 'failed' });
        }

        res.setHeader('Content-Type', `audio/${format}`);
        res.setHeader('Content-Length', String(audioBuffer.length));
        res.status(200).send(audioBuffer);
    }

    /**
     * Generates audio for an article's summary (as opposed to the full
     * article). Mirrors `ArticleController.generateSummaryAudio`.
     */
    @Get(':id/summary/audio')
    async generateSummaryAudio(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Param('id') id: string,
        @Res({ passthrough: false }) res: Response,
        @Query('voice') voice?: 'Puck' | 'Charon' | 'Kore' | 'Fenrir',
        @Query('speed') speed?: string,
    ): Promise<void> {
        const { user, hasProAccess } = await this.getAuthContext(currentUser);
        const parsedSpeed = speed ? parseFloat(speed) : undefined;

        if (id.startsWith('url-only-')) {
            throw new BadRequestException(
                "Cannot generate audio for URL-only entries. The article content extraction failed, so there's no summary to read.",
            );
        }

        const userArticleLink = await this.userArticlesService.findByUserAndArticle(user.id, id);
        if (!userArticleLink?.summary || userArticleLink.summary === 'pending') {
            throw new NotFoundException('Summary not found or is still being generated.');
        }

        const { audioBuffer, format } = await this.genAiService.generateSummaryAudio(
            id,
            userArticleLink.summary,
            hasProAccess,
            { voice, speed: parsedSpeed },
        );

        res.setHeader('Content-Type', `audio/${format}`);
        res.setHeader('Content-Length', String(audioBuffer.length));
        res.status(200).send(audioBuffer);
    }

    /**
     * Generates (or returns the cached URL for) a Pro-only multi-speaker
     * podcast for an article. Actual generation is offloaded to the
     * audio-generation job queue. Mirrors
     * `ArticleController.generatePodcastAudio`.
     */
    @Get(':id/podcast-audio')
    async generatePodcastAudio(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Param('id') id: string,
        @Query('duration') duration?: 'short' | 'medium' | 'long',
        @Query('style') style?: 'casual' | 'professional' | 'educational',
        @Query('voices') voices?: string,
        @Query('personaId') personaId?: string,
        @Query('language') language?: string,
        @Query('force') force?: string,
    ): Promise<{ audioUrl: string }> {
        const { user, hasProAccess } = await this.getAuthContext(currentUser);
        const forceRegenerate = force === 'true';

        if (!hasProAccess) {
            throw new HttpException(
                'Podcast generation is a Pro-only feature. Please upgrade to Pro to access this feature.',
                HttpStatus.PAYMENT_REQUIRED,
            );
        }

        const userArticle = await this.userArticlesService.findByUserAndArticle(user.id, id);

        if (userArticle?.audioLocation && !forceRegenerate) {
            return { audioUrl: userArticle.audioLocation };
        }

        const existingUrl = await this.storageService.checkAudioExists(id, user.id, 'podcast');
        if (existingUrl && !forceRegenerate) {
            if (userArticle) {
                await this.userArticlesService.updateById(userArticle.id, { audioLocation: existingUrl });
            }
            return { audioUrl: existingUrl };
        }

        if (id.startsWith('url-only-')) {
            throw new BadRequestException('Cannot generate podcast for URL-only entries.');
        }

        const article = await this.articlesService.findById(id);
        if (!article?.content) {
            throw new NotFoundException('Article content not found.');
        }

        try {
            await this.userArticlesService.updateById(userArticle!.id, {
                audioStatus: 'pending',
                audioLanguage: language || 'en',
            });

            await this.jobQueueService.addAudioJob({
                articleId: id,
                userId: user.id,
                title: article.title || 'Untitled Article',
                content: article.content,
                duration,
                style,
                voices,
                personaId,
                language,
            });

            return { audioUrl: 'processing' };
        } catch (error) {
            try {
                await this.userArticlesService.updateById(userArticle!.id, { audioStatus: 'failed' });
            } catch (dbError) {
                console.error('❌ Failed to update audio status to failed:', dbError);
            }
            throw new InternalServerErrorException(
                `Podcast generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
            );
        }
    }

    @Delete(':id/podcast-audio')
    async deletePodcastAudio(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Param('id') id: string,
    ): Promise<void> {
        const { user, hasProAccess } = await this.getAuthContext(currentUser);

        if (!hasProAccess) {
            throw new HttpException(
                'This is a Pro-only feature. Please upgrade to Pro to manage podcast audio.',
                HttpStatus.PAYMENT_REQUIRED,
            );
        }

        const userArticle = await this.userArticlesService.findByUserAndArticle(user.id, id);
        if (!userArticle) {
            throw new NotFoundException('Article not found for this user.');
        }

        if (!userArticle.audioLocation) {
            return;
        }

        try {
            await this.storageService.deletePodcastAudio(userArticle.audioLocation);

            await this.userArticlesService.updateById(userArticle.id, {
                audioLocation: undefined,
                podcastScript: undefined,
                audioStatus: 'idle',
            });
        } catch (error) {
            if (error instanceof Error && error.message.includes('not found')) {
                await this.userArticlesService.updateById(userArticle.id, {
                    audioLocation: undefined,
                    podcastScript: undefined,
                    audioStatus: 'idle',
                });
                return;
            }
            throw new InternalServerErrorException(
                `Podcast deletion failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
            );
        }
    }

    @Get(':id/podcast-download')
    async downloadPodcast(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Param('id') id: string,
        @Res({ passthrough: false }) res: Response,
    ): Promise<void> {
        const { user, hasProAccess } = await this.getAuthContext(currentUser);
        if (!hasProAccess) {
            throw new UnauthorizedException('Download requires valid Pro subscription.');
        }

        const userArticle = await this.userArticlesService.findByUserAndArticle(user.id, id);
        if (!userArticle || !userArticle.audioLocation) {
            throw new NotFoundException('Podcast not found for this article.');
        }

        const audioUrl = userArticle.audioLocation;
        const extension = audioUrl.split('.').pop()?.split('?')[0]?.toLowerCase() || 'mp3';
        let mimeType = 'audio/mpeg';
        if (extension === 'm4a') mimeType = 'audio/mp4';
        else if (extension === 'wav') mimeType = 'audio/wav';
        else if (extension === 'aac') mimeType = 'audio/aac';

        const filename = `podcast_overview_${id}.${extension}`;
        res.contentType(mimeType);
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

        try {
            const stream = await this.storageService.getAudioStream(audioUrl);
            stream.pipe(res);
        } catch (err) {
            console.error('Failed to stream audio download:', err);
            throw new InternalServerErrorException('Failed to download audio file.');
        }
    }

    @Get(':id/podcast-status')
    async getPodcastStatus(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Param('id') id: string,
    ): Promise<{
        hasAudio: boolean;
        audioUrl?: string;
        status?: string;
        canGenerate: boolean;
        isProUser: boolean;
        audioLanguage?: string;
    }> {
        const { user, hasProAccess } = await this.getAuthContext(currentUser);

        if (id.startsWith('url-only-')) {
            return { hasAudio: false, canGenerate: false, isProUser: hasProAccess, audioLanguage: undefined };
        }

        const userArticle = await this.userArticlesService.findByUserAndArticle(user.id, id);

        if (userArticle?.audioLocation) {
            return {
                hasAudio: true,
                audioUrl: userArticle.audioLocation,
                status: userArticle.audioStatus || 'completed',
                canGenerate: hasProAccess,
                isProUser: hasProAccess,
                audioLanguage: userArticle.audioLanguage,
            };
        }

        return {
            hasAudio: false,
            audioUrl: undefined,
            status: userArticle?.audioStatus || 'idle',
            canGenerate: hasProAccess,
            isProUser: hasProAccess,
            audioLanguage: userArticle?.audioLanguage,
        };
    }
}
