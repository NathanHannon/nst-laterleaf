/**
 * Content Moderation Service for LaterLeaf
 *
 * Purpose: Multi-layer content filtering for article recommendations:
 * 1. Domain blocklist check (local database)
 * 2. OpenAI Moderation API for content analysis
 *
 * This prevents inappropriate content from appearing in recommendations while
 * preserving user freedom to save any content to personal libraries.
 *
 * Ported from lb-laterleaf/src/services/content-moderation.service.ts.
 * NOTE: the original LB service was `@injectable({scope: TRANSIENT})`; here
 * it's a regular (singleton) Nest provider, which better matches the intent
 * of the in-memory blocked-domains cache and rate-limit counters (persisting
 * across requests instead of being reset per-injection).
 */
import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import { BlockedDomainsService } from './blocked-domains.service';
import { ModerationAnalysis, SafeBrowsingResult } from './interfaces/content-moderation.interface';

@Injectable()
export class ContentModerationService {
    // Cache blocked domains for performance
    private blockedDomainsCache: Set<string> = new Set();
    private cacheLastUpdated = 0;
    private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

    // Rate limiting for OpenAI API - more conservative approach
    private lastOpenAICall = 0;
    private readonly MIN_OPENAI_INTERVAL = 500; // 500ms = ~120 requests per minute (very conservative)
    private callCount = 0;
    private windowStart: number = Date.now();
    private readonly CALLS_PER_MINUTE = 100; // Much more conservative buffer
    private readonly WINDOW_SIZE = 60 * 1000; // 1 minute window

    private openai: OpenAI;

    constructor(private readonly blockedDomainsService: BlockedDomainsService) {
        this.openai = new OpenAI({
            apiKey: this.getOpenAIKey(),
        });
    }

    private getOpenAIKey(): string {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
            throw new Error('OpenAI API key not configured');
        }
        return apiKey;
    }

    private getGoogleSafeBrowsingKey(): string {
        const apiKey = process.env.GOOGLE_SAFE_BROWSING_API_KEY;
        if (!apiKey) {
            throw new Error('Google Safe Browsing API key not configured');
        }
        return apiKey;
    }

    /**
     * Implements rate limiting for OpenAI API calls.
     */
    private async enforceRateLimit(): Promise<void> {
        const now = Date.now();

        if (now - this.windowStart >= this.WINDOW_SIZE) {
            console.log(
                `🔄 [MODERATION] Resetting rate limit window. Previous: ${this.callCount}/${this.CALLS_PER_MINUTE} calls`,
            );
            this.windowStart = now;
            this.callCount = 0;
        }

        if (this.callCount >= this.CALLS_PER_MINUTE) {
            const waitTime = this.WINDOW_SIZE - (now - this.windowStart);
            console.log(
                `⏳ [MODERATION] Rate limit: ${this.callCount}/${this.CALLS_PER_MINUTE} calls in window. Waiting ${Math.round(waitTime / 1000)}s`,
            );
            await new Promise((resolve) => setTimeout(resolve, waitTime));

            this.windowStart = Date.now();
            this.callCount = 0;
            console.log(`🔄 [MODERATION] Rate limit window reset after waiting`);
        }

        const timeSinceLastCall = now - this.lastOpenAICall;
        if (timeSinceLastCall < this.MIN_OPENAI_INTERVAL) {
            const waitTime = this.MIN_OPENAI_INTERVAL - timeSinceLastCall;
            console.log(`⏸️  [MODERATION] Burst protection: waiting ${waitTime}ms (last call ${timeSinceLastCall}ms ago)`);
            await new Promise((resolve) => setTimeout(resolve, waitTime));
        }

        this.callCount++;
        this.lastOpenAICall = Date.now();

        console.log(`📊 [MODERATION] Rate limit status: ${this.callCount}/${this.CALLS_PER_MINUTE} calls in current window`);
    }

    /**
     * Checks a URL against Google Safe Browsing API for known threats.
     */
    private async checkSafeBrowsing(url: string): Promise<SafeBrowsingResult> {
        try {
            console.log(`\n🛡️  [SAFE BROWSING START] Checking URL: ${url}`);

            let apiKey: string;
            try {
                apiKey = this.getGoogleSafeBrowsingKey();
            } catch {
                console.warn(`⚠️  [SAFE BROWSING] API key not configured - skipping check`);
                return { isThreat: false };
            }

            const requestBody = {
                client: {
                    clientId: 'laterleaf',
                    clientVersion: '1.0.0',
                },
                threatInfo: {
                    threatTypes: [
                        'MALWARE',
                        'SOCIAL_ENGINEERING',
                        'UNWANTED_SOFTWARE',
                        'POTENTIALLY_HARMFUL_APPLICATION',
                        'THREAT_TYPE_UNSPECIFIED',
                    ],
                    platformTypes: ['ALL_PLATFORMS'],
                    threatEntryTypes: ['URL'],
                    threatEntries: [{ url }],
                },
            };

            console.log(`📤 [SAFE BROWSING] Sending request to Google API...`);
            const startTime = Date.now();

            const response = await fetch(`https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${apiKey}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestBody),
            });

            const responseTime = Date.now() - startTime;
            console.log(`📥 [SAFE BROWSING] Response received in ${responseTime}ms`);

            if (!response.ok) {
                console.error(`❌ [SAFE BROWSING] API error: ${response.status} ${response.statusText}`);
                console.log(`✅ [SAFE BROWSING] Failing open - allowing content due to API error`);
                return { isThreat: false };
            }

            const result = await response.json();
            console.log(`📊 [SAFE BROWSING] API Response:`, JSON.stringify(result, null, 2));

            if (result.matches && result.matches.length > 0) {
                const match = result.matches[0];
                console.log(`🚨 [SAFE BROWSING] ⚠️  THREAT DETECTED: ${url}`);
                console.log(`   🏷️  Threat Type: ${match.threatType}`);
                console.log(`   💻 Platform: ${match.platformType}`);
                console.log(`   🔗 Entry Type: ${match.threatEntryType}`);
                console.log(`   📋 Full Match:`, JSON.stringify(match, null, 2));

                return {
                    isThreat: true,
                    threatType: match.threatType,
                    platformType: match.platformType,
                    threatEntryType: match.threatEntryType,
                };
            }

            console.log(`✅ [SAFE BROWSING] ✅ URL is clean: ${url}`);
            return { isThreat: false };
        } catch (error) {
            console.error(`❌ [SAFE BROWSING] Check failed for ${url}:`, error);
            console.log(`✅ [SAFE BROWSING] Failing open - allowing content due to error`);
            return { isThreat: false };
        }
    }

    private extractDomain(url: string): string {
        try {
            const urlObj = new URL(url);
            return urlObj.hostname.toLowerCase();
        } catch {
            console.warn(`Invalid URL format: ${url}`);
            return '';
        }
    }

    private async updateBlockedDomainsCache(): Promise<void> {
        const now = Date.now();
        if (now - this.cacheLastUpdated > this.CACHE_TTL) {
            const blockedDomains = await this.blockedDomainsService.getAllBlockedDomains();
            this.blockedDomainsCache = new Set(blockedDomains);
            this.cacheLastUpdated = now;
            console.log(`📋 [MODERATION] Updated blocked domains cache: ${blockedDomains.length} domains`);
        }
    }

    private async isDomainBlocked(url: string): Promise<{
        isBlocked: boolean;
        reason?: string;
    }> {
        const domain = this.extractDomain(url);
        if (!domain) {
            return { isBlocked: false };
        }

        await this.updateBlockedDomainsCache();

        if (this.blockedDomainsCache.has(domain)) {
            const domainInfo = await this.blockedDomainsService.isDomainBlocked(domain);
            return {
                isBlocked: true,
                reason: domainInfo.reason,
            };
        }

        return { isBlocked: false };
    }

    /**
     * Enhanced image URL validation for better image detection.
     */
    private isValidImageUrl(url: string): boolean {
        try {
            const urlObj = new URL(url);
            const pathname = urlObj.pathname.toLowerCase();
            const hostname = urlObj.hostname.toLowerCase();

            const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'];
            const hasImageExtension = imageExtensions.some((ext) => pathname.endsWith(ext));

            const imageHostPatterns = [
                'images.',
                'img.',
                'cdn.',
                'static.',
                'media.',
                'amazonaws.com',
                'cloudinary.com',
                'imgur.com',
                'unsplash.com',
                'pexels.com',
            ];
            const isImageHost = imageHostPatterns.some((pattern) => hostname.includes(pattern));

            const hasImagePath =
                pathname.includes('/image') ||
                pathname.includes('/img/') ||
                pathname.includes('/media/') ||
                pathname.includes('/assets/');

            const isValid = hasImageExtension || isImageHost || hasImagePath;

            if (isValid) {
                console.log(`🖼️  [MODERATION] Valid image URL detected: ${url}`);
            }

            return isValid;
        } catch {
            console.warn(`🖼️  [MODERATION] Invalid image URL format: ${url}`);
            return false;
        }
    }

    /**
     * Strips query parameters and fragments from an image URL.
     */
    private cleanImageUrl(imageUrl: string): string {
        try {
            const urlObj = new URL(imageUrl);
            const cleanUrl = `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}`;

            if (cleanUrl !== imageUrl) {
                console.log(`🧹 [MODERATION] Cleaned image URL: ${imageUrl} → ${cleanUrl}`);
            }

            return cleanUrl;
        } catch {
            console.warn(`🧹 [MODERATION] Failed to clean image URL: ${imageUrl}`);
            return imageUrl;
        }
    }

    /**
     * Analyzes content using the OpenAI Moderation API with rate limiting.
     */
    private async analyzeWithOpenAI(
        title: string,
        excerpt: string,
        content?: string,
        imageUrl?: string,
    ): Promise<{
        flagged: boolean;
        categories: string[];
        maxScore: number;
        reasoning: string;
        imageAnalyzed: boolean;
        imageFlagged?: boolean;
        imageCategories?: string[];
    }> {
        const text = `${title}\n\n${excerpt}\n\n${content?.substring(0, 1500) || ''}`.trim();

        console.log(`🔍 [MODERATION] Analyzing content`);
        console.log(`📝 Text Length: ${text.length} characters`);
        console.log(`🖼️  Image URL: ${imageUrl ? 'Provided - will analyze' : 'None'}`);

        try {
            await this.enforceRateLimit();

            let input: OpenAI.Moderations.ModerationCreateParams['input'];
            let imageAnalyzed = false;

            if (imageUrl && this.isValidImageUrl(imageUrl)) {
                const cleanedImageUrl = this.cleanImageUrl(imageUrl);

                input = [
                    {
                        type: 'text',
                        text: text,
                    },
                    {
                        type: 'image_url',
                        image_url: {
                            url: cleanedImageUrl,
                        },
                    },
                ];
                imageAnalyzed = true;
                console.log(`🖼️  [MODERATION] Including image analysis for: ${cleanedImageUrl}`);
            } else {
                input = text;
                console.log(`📝 [MODERATION] Text-only analysis (no valid image URL)`);
            }

            console.log(`🤖 [MODERATION] Calling OpenAI Moderation API (${this.callCount}/${this.CALLS_PER_MINUTE})...`);

            const moderation = await this.openai.moderations.create({
                model: 'omni-moderation-latest',
                input: input,
            });

            let textModeration, imageModeration;

            if (imageAnalyzed && moderation.results.length > 1) {
                textModeration = moderation.results[0];
                imageModeration = moderation.results[1];
            } else {
                textModeration = moderation.results[0];
                imageModeration = undefined;
            }

            const textFlaggedCategories = Object.entries(textModeration.categories)
                .filter(([, flagged]) => flagged)
                .map(([category]) => category);

            let imageFlaggedCategories: string[] = [];
            let imageFlagged = false;
            if (imageModeration) {
                imageFlaggedCategories = Object.entries(imageModeration.categories)
                    .filter(([, flagged]) => flagged)
                    .map(([category]) => category);
                imageFlagged = imageModeration.flagged;
            }

            const allFlaggedCategories = [...textFlaggedCategories, ...imageFlaggedCategories];
            const overallFlagged = textModeration.flagged || imageFlagged;

            const textMaxScore = Math.max(...(Object.values(textModeration.category_scores) as number[]));
            const imageMaxScore = imageModeration
                ? Math.max(...(Object.values(imageModeration.category_scores) as number[]))
                : 0;
            const maxScore = Math.max(textMaxScore, imageMaxScore);

            let reasoning = 'Content passed OpenAI moderation';
            if (overallFlagged) {
                const reasoningParts: string[] = [];
                if (textModeration.flagged) {
                    reasoningParts.push(`Text: ${textFlaggedCategories.join(', ')}`);
                }
                if (imageFlagged) {
                    reasoningParts.push(`Image: ${imageFlaggedCategories.join(', ')}`);
                }
                reasoning = `Flagged for ${reasoningParts.join(' | ')}`;
            }

            console.log(`✅ [MODERATION] OpenAI analysis complete`);
            console.log(`📊 Text flagged: ${textModeration.flagged ? '❌' : '✅'}`);
            if (imageAnalyzed) {
                console.log(`🖼️  Image flagged: ${imageFlagged ? '❌' : '✅'}`);
            }
            console.log(`🎯 Overall result: ${overallFlagged ? '❌ FLAGGED' : '✅ PASSED'}`);
            if (allFlaggedCategories.length > 0) {
                console.log(`🏷️  Flagged categories: ${allFlaggedCategories.join(', ')}`);
            }
            console.log(`💯 Max score: ${maxScore.toFixed(3)}`);

            console.log(`📈 [MODERATION] Detailed scores:`);
            console.log(
                `   Text scores:`,
                Object.entries(textModeration.category_scores)
                    .map(([cat, score]) => `${cat}: ${(score as number).toFixed(3)}`)
                    .join(', '),
            );

            if (imageModeration) {
                console.log(
                    `   Image scores:`,
                    Object.entries(imageModeration.category_scores)
                        .map(([cat, score]) => `${cat}: ${(score as number).toFixed(3)}`)
                        .join(', '),
                );
            }

            const wouldBeIllegal = this.isIllegalContent(allFlaggedCategories);
            console.log(`⚖️  [MODERATION] Would be blocked for saving: ${wouldBeIllegal ? '🚫 YES' : '✅ NO'}`);
            if (wouldBeIllegal) {
                console.log(
                    `   🔍 Illegal categories detected: ${allFlaggedCategories
                        .filter((cat) => ['sexual/minors', 'violence/graphic'].includes(cat))
                        .join(', ')}`,
                );
            }

            return {
                flagged: overallFlagged,
                categories: allFlaggedCategories,
                maxScore,
                reasoning,
                imageAnalyzed,
                imageFlagged,
                imageCategories: imageFlaggedCategories,
            };
        } catch (error) {
            if (error instanceof OpenAI.APIError) {
                console.error('❌ [MODERATION] OpenAI API error:', {
                    status: error.status,
                    message: error.message,
                    code: error.code,
                    type: error.type,
                });

                if (error.status === 429) {
                    console.warn(`⚠️  [MODERATION] Rate limit hit - backing off for 2 minutes`);

                    this.windowStart = Date.now() + 2 * 60 * 1000;
                    this.callCount = this.CALLS_PER_MINUTE;

                    return {
                        flagged: false,
                        categories: [],
                        maxScore: 0,
                        reasoning: 'OpenAI rate limit hit - content defaulted to appropriate (admin review recommended)',
                        imageAnalyzed: false,
                    };
                }

                if (error.message?.includes('image') && imageUrl) {
                    console.warn(`🖼️  [MODERATION] Image analysis failed, retrying with text-only`);

                    const textOnlyModeration = await this.openai.moderations.create({
                        model: 'omni-moderation-latest',
                        input: text,
                    });

                    const retryTextModeration = textOnlyModeration.results[0];
                    const retryTextFlaggedCategories = Object.entries(retryTextModeration.categories)
                        .filter(([, flagged]) => flagged)
                        .map(([category]) => category);

                    return {
                        flagged: retryTextModeration.flagged,
                        categories: retryTextFlaggedCategories,
                        maxScore: Math.max(...Object.values(retryTextModeration.category_scores)),
                        reasoning: retryTextModeration.flagged
                            ? `Text flagged for: ${retryTextFlaggedCategories.join(', ')} (image analysis failed)`
                            : 'Content passed text moderation (image analysis failed)',
                        imageAnalyzed: false,
                    };
                }
            } else {
                console.error('❌ [MODERATION] OpenAI analysis failed:', error);
            }

            return {
                flagged: false,
                categories: [],
                maxScore: 0,
                reasoning: 'OpenAI Moderation API failed - defaulted to appropriate',
                imageAnalyzed: false,
            };
        }
    }

    /**
     * Determines if content contains illegal material that should be completely blocked from saving.
     */
    private isIllegalContent(categories: string[]): boolean {
        const illegalCategories = ['sexual/minors', 'violence/graphic'];
        return categories.some((category) => illegalCategories.includes(category));
    }

    /**
     * Moderates content to determine if it should be blocked from saving entirely.
     */
    async moderateForSaving(
        url: string,
        title: string,
        excerpt: string,
        content?: string,
        imageUrl?: string,
    ): Promise<{
        shouldBlockSave: boolean;
        reasoning: string;
        confidence: number;
        flaggedCategories: string[];
        imageAnalyzed: boolean;
        safeBrowsingThreat?: string;
    }> {
        console.log(`\n🚨 [SAVE MODERATION START] ${this.extractDomain(url)}`);

        const safeBrowsingResult = await this.checkSafeBrowsing(url);

        if (safeBrowsingResult.isThreat) {
            console.log(`🚨 [SAVE MODERATION END] 🚫 BLOCKED BY SAFE BROWSING - ${safeBrowsingResult.threatType}\n`);
            return {
                shouldBlockSave: true,
                reasoning: `URL blocked by Google Safe Browsing: ${safeBrowsingResult.threatType}`,
                confidence: 0.99,
                flaggedCategories: [safeBrowsingResult.threatType || 'UNKNOWN_THREAT'],
                imageAnalyzed: false,
                safeBrowsingThreat: safeBrowsingResult.threatType,
            };
        }

        const openAIResult = await this.analyzeWithOpenAI(title, excerpt, content, imageUrl);

        const hasIllegalContent = this.isIllegalContent(openAIResult.categories);

        let reasoning: string;
        if (hasIllegalContent) {
            reasoning = `Content blocked due to illegal material: ${openAIResult.categories.join(', ')}`;
        } else if (openAIResult.flagged) {
            reasoning = `Content flagged but not illegal: ${openAIResult.categories.join(', ')}`;
        } else {
            reasoning = 'Content passed moderation for saving';
        }

        const confidence = hasIllegalContent ? 0.98 : 0.85;

        console.log(
            `🚨 [SAVE MODERATION END] ${hasIllegalContent ? '🚫 BLOCKED' : '✅ ALLOWED'} (${(confidence * 100).toFixed(0)}% confidence)`,
        );
        if (hasIllegalContent) {
            console.log(`⚠️  [ILLEGAL CONTENT] Categories: ${openAIResult.categories.join(', ')}`);
        }

        return {
            shouldBlockSave: hasIllegalContent,
            reasoning,
            confidence,
            flaggedCategories: openAIResult.categories,
            imageAnalyzed: openAIResult.imageAnalyzed,
        };
    }

    /**
     * Moderates content for eligibility in recommendations.
     */
    async moderateForRecommendations(
        url: string,
        title: string,
        excerpt: string,
        content?: string,
        imageUrl?: string,
    ): Promise<ModerationAnalysis> {
        console.log(`\n🔍 [MODERATION START] ${this.extractDomain(url)}`);

        const domainCheck = await this.isDomainBlocked(url);

        if (domainCheck.isBlocked) {
            console.log(`❌ [MODERATION] Domain blocked: ${this.extractDomain(url)} - ${domainCheck.reason}`);
            return {
                isEligibleForRecommendation: false,
                confidence: 1.0,
                reasoning: `Domain blocked: ${domainCheck.reason}`,
                blockedByDomain: true,
                flaggedByOpenAI: false,
                openAICategories: [],
                domainReason: domainCheck.reason,
                imageAnalyzed: false,
            };
        }

        const openAIResult = await this.analyzeWithOpenAI(title, excerpt, content, imageUrl);

        const isEligible = !openAIResult.flagged;
        const confidence = openAIResult.flagged ? 0.95 : 0.9;

        console.log(`🎯 [MODERATION END] ${isEligible ? '✅ ELIGIBLE' : '❌ NOT ELIGIBLE'} (${(confidence * 100).toFixed(0)}% confidence)\n`);

        return {
            isEligibleForRecommendation: isEligible,
            confidence,
            reasoning: openAIResult.reasoning,
            blockedByDomain: false,
            flaggedByOpenAI: openAIResult.flagged,
            openAICategories: openAIResult.categories,
            imageAnalyzed: openAIResult.imageAnalyzed,
            imageFlagged: openAIResult.imageFlagged,
            imageCategories: openAIResult.imageCategories,
        };
    }

    /**
     * Blocks a domain for a specified reason and optional notes.
     */
    async blockDomain(
        domain: string,
        reason: 'spam' | 'malicious' | 'inappropriate' | 'scam' | 'phishing',
        notes?: string,
    ): Promise<void> {
        await this.blockedDomainsService.create({
            domain: domain.toLowerCase(),
            reason,
            notes,
        });

        this.cacheLastUpdated = 0;
        console.log(`🚫 [MODERATION] Domain blocked: ${domain} - ${reason}`);
    }

    /**
     * Unblocks a previously blocked domain.
     */
    async unblockDomain(domain: string): Promise<void> {
        await this.blockedDomainsService.deleteByDomain(domain);

        this.cacheLastUpdated = 0;
        console.log(`✅ [MODERATION] Domain unblocked: ${domain}`);
    }
}
