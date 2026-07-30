import { Injectable } from '@nestjs/common';
import { Readability } from '@mozilla/readability';
import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import { SCRAPING_UTILS } from './utils/scraping-utils';
import { MetadataScrapingService } from './metadata-scraping.service';
import { RobotsTxtService } from './robots-txt.service';

interface ExtractedArticle {
    title: string;
    excerpt: string;
    content: string;
    contentHtml: string;
    author?: string;
    imageUrl?: string;
    publishedDate?: Date;
    hasContent: boolean;
    contentType?: string;
    readingTime?: number;
}

interface DomainExtractionConfig {
    additionalSelectorsToRemove?: string[];
    contentSelector?: string;
    skipLeafDivConversion?: boolean;
}

const DOMAIN_EXTRACTION_CONFIG: Record<string, DomainExtractionConfig> = {
    'apple.com': {
        contentSelector: 'article.article, [class*="pagebody"]',
    },
    'medium.com': {
        additionalSelectorsToRemove: [
            '[data-testid="publicationNavbar"]',
            '[data-testid="headerStickyAd"]',
            'section[data-testid="responsesSectionTitle"]',
        ],
    },
    'substack.com': {
        contentSelector: '.body.markup',
        additionalSelectorsToRemove: ['[class*="subscribe"]', '[class*="paywall"]'],
    },
    'nytimes.com': {
        additionalSelectorsToRemove: [
            '[data-testid="inline-message"]',
            '[class*="SectionBar"]',
            '[class*="RegiwallInline"]',
        ],
    },
    'theguardian.com': {
        contentSelector: '[data-gu-name="body"]',
        additionalSelectorsToRemove: ['[class*="submeta"]', '[class*="rich-link"]'],
    },
    'bbc.com': {
        contentSelector: '[data-component="text-block"], article',
    },
    'bbc.co.uk': {
        contentSelector: '[data-component="text-block"], article',
    },
};

function getDomainConfig(url: string): DomainExtractionConfig | null {
    try {
        const hostname = new URL(url).hostname.replace(/^www\./, '');
        if (DOMAIN_EXTRACTION_CONFIG[hostname]) return DOMAIN_EXTRACTION_CONFIG[hostname];
        const parts = hostname.split('.');
        for (let i = 1; i < parts.length - 1; i++) {
            const suffix = parts.slice(i).join('.');
            if (DOMAIN_EXTRACTION_CONFIG[suffix]) return DOMAIN_EXTRACTION_CONFIG[suffix];
        }
    } catch {
        /* ignore invalid URLs */
    }
    return null;
}

/**
 * Ports lb-laterleaf/src/services/content-extraction.service.ts.
 * See copilot-instructions.md section 7 for the extraction pipeline
 * architecture (static fetch -> preCleanHtml -> JSDOM -> cleanDomForReadability
 * -> Readability.js -> hybrid merge with JSON-LD). Keep in sync with
 * browser-extension/src/content/extractor.ts when modifying this logic.
 */
@Injectable()
export class ContentExtractionService {
    constructor(
        private readonly robotsTxtService: RobotsTxtService,
        private readonly metadataScrapingService: MetadataScrapingService,
    ) { }

    async extractFromHtml(html: string, url: string): Promise<ExtractedArticle> {
        return this.parseHtml(html, url);
    }

    async extractContent(url: string): Promise<{
        title: string;
        excerpt: string;
        content: string;
        contentHtml: string;
        imageUrl?: string;
        publishedDate?: Date;
        extractionMethod: 'static' | 'failed';
        processingTimeMs: number;
        canonicalUrl?: string;
        paginationDetected?: boolean;
        contentType?: string;
    }> {
        const startTime = Date.now();
        console.log(`🔍 [EXTRACTION] Starting extraction for: ${url}`);

        try {
            const randomUserAgent = SCRAPING_UTILS.getRandomUserAgent();
            console.log(`👤 [EXTRACTION] Trying with Random Browser User Agent`);
            const staticResult = await this.tryStaticExtractionWithCanonical(url, randomUserAgent);

            if (staticResult.hasContent) {
                const processingTime = Date.now() - startTime;
                console.log(`✅ [EXTRACTION] Static extraction succeeded with random UA in ${processingTime}ms`);

                const metadata = await this.metadataScrapingService.scrapeMetadata(url, staticResult.rawHtml);

                return {
                    ...staticResult,
                    contentType: metadata.contentType,
                    extractionMethod: 'static',
                    processingTimeMs: processingTime,
                };
            }

            const processingTime = Date.now() - startTime;
            console.log(
                `⚠️ [EXTRACTION] Got HTML but hasContent=false after ${processingTime}ms. Title: "${staticResult.title.substring(0, 50)}", Content length: ${staticResult.content.length}`,
            );

            if (staticResult.rawHtml && staticResult.rawHtml.length > 1000) {
                throw new Error(
                    "We couldn't extract the article content from this page. This site may require JavaScript rendering — try saving it with the LaterLeaf browser extension instead.",
                );
            } else {
                throw new Error(
                    "We couldn't access this website. It may be temporarily unavailable, require special permissions, or block automated access.",
                );
            }
        } catch (error) {
            if (error.message.includes("We couldn't")) {
                throw error;
            }

            console.log(`🚫 [EXTRACTION] Extraction failed (${error.message})`);

            if (error.message.includes('CRITICAL_BLOCK')) {
                throw error;
            }

            const processingTime = Date.now() - startTime;
            console.error(`❌ [EXTRACTION] Failed after ${processingTime}ms:`, error.message);

            if (error.message.includes('403') || error.message.includes('401') || error.message.includes('429')) {
                throw new Error("This website blocked our request. Try saving it with the LaterLeaf browser extension instead.");
            }

            throw new Error('Unable to extract content from this URL. This may be due to a network error or the site being offline.');
        }
    }

    private async tryStaticExtraction(url: string, userAgent: string): Promise<ExtractedArticle & { rawHtml: string }> {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        const response = await fetch(url, {
            headers: {
                'User-Agent': userAgent,
            },
            signal: controller.signal,
        }).finally(() => clearTimeout(timeoutId));

        if (!response.ok) {
            throw new Error(`HTTP Error ${response.status}: ${response.statusText}`);
        }

        const html = await response.text();
        const article = this.parseHtml(html, url);

        return { ...article, rawHtml: html };
    }

    private detectCanonicalUrl(html: string, currentUrl: string): string | null {
        try {
            const dom = new JSDOM(html);
            const canonicalElement = dom.window.document.querySelector('link[rel="canonical"]') as HTMLLinkElement;

            if (canonicalElement && canonicalElement.href) {
                const canonicalUrl = new URL(canonicalElement.href, currentUrl).toString();

                if (canonicalUrl !== currentUrl) {
                    console.log(`🔗 [CANONICAL] Found canonical URL: ${canonicalUrl}`);
                    return canonicalUrl;
                }
            }

            return null;
        } catch (error) {
            console.warn(`⚠️ [CANONICAL] Error detecting canonical URL:`, error.message);
            return null;
        }
    }

    private async tryStaticExtractionWithCanonical(
        url: string,
        userAgent: string,
    ): Promise<ExtractedArticle & { rawHtml: string; canonicalUrl?: string }> {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        const response = await fetch(url, {
            headers: {
                'User-Agent': userAgent,
            },
            signal: controller.signal,
        }).finally(() => clearTimeout(timeoutId));

        if (!response.ok) {
            throw new Error(`HTTP Error ${response.status}: ${response.statusText}`);
        }

        const html = await response.text();

        const canonicalUrl = this.detectCanonicalUrl(html, url);

        if (canonicalUrl) {
            console.log(`🔗 [CANONICAL] Extracting from canonical URL instead of: ${url}`);
            if (canonicalUrl !== url) {
                try {
                    const canonicalResult = await this.tryStaticExtraction(canonicalUrl, userAgent);
                    return {
                        ...canonicalResult,
                        canonicalUrl: canonicalUrl,
                    };
                } catch (error) {
                    console.warn(`⚠️ [CANONICAL] Failed to extract from canonical URL, using original:`, error.message);
                }
            }
        }

        const article = this.parseHtml(html, url);
        return { ...article, rawHtml: html, canonicalUrl: canonicalUrl || undefined };
    }

    private parseHtml(html: string, url: string): ExtractedArticle {
        if (
            html.includes('Our systems have detected unusual traffic from your computer network') ||
            html.includes("This page checks to see if it's really you sending the requests")
        ) {
            console.error(`🚨 [EXTRACTION] Google Unusual Traffic Block detected for ${url}`);
            throw new Error('CRITICAL_BLOCK: Google Unusual Traffic');
        }

        const preCleanedHtml = this.preCleanHtml(html);
        const dom = new JSDOM(preCleanedHtml, { url });

        console.log('🔍 [STRUCTURED] Attempting structured data extraction...');

        const metadataResult = this.extractMetadataOnly(dom.window.document);
        const structuredResult = this.extractFromStructuredData(dom.window.document);

        const visualPaywallDetected = this.detectVisualPaywall(dom.window.document, url);
        if (visualPaywallDetected) {
            console.log('🔒 [EXTRACTION] Visual Paywall Detected in DOM. Disabling Safe-Upgrade from JSON-LD.');
        }

        const domainConfig = getDomainConfig(url);
        if (domainConfig) {
            console.log(`🗺️ [EXTRACTION] Applying domain config for ${new URL(url).hostname}`);
        }

        this.cleanDomForReadability(dom.window.document, domainConfig ?? undefined);

        let readabilityDoc = dom.window.document;
        if (domainConfig?.contentSelector) {
            const contentEl = dom.window.document.querySelector(domainConfig.contentSelector);
            if (contentEl) {
                const scopedDom = new JSDOM(`<html><body>${contentEl.outerHTML}</body></html>`, { url });
                readabilityDoc = scopedDom.window.document;
                console.log(`🎯 [EXTRACTION] Scoped to "${domainConfig.contentSelector}"`);
            }
        }

        const reader = new Readability(readabilityDoc);
        const article = reader.parse();

        let readabilityContent = '';
        let readabilityHtml = '';
        let readabilityTitle = '';

        if (article && article.content) {
            readabilityContent = article.textContent || '';
            readabilityHtml = article.content;
            readabilityTitle = article.title || '';
        }

        const window = new JSDOM('').window;
        const DOMPurify = createDOMPurify(window as unknown as Parameters<typeof createDOMPurify>[0]);
        const sanitizedHtml = DOMPurify.sanitize(readabilityHtml, {
            USE_PROFILES: { html: true },
            FORBID_TAGS: [
                'img',
                'figure',
                'picture',
                'video',
                'audio',
                'iframe',
                'uni-image-full-width',
                'uni-youtube-player-article',
                'uni-related-content-tout',
            ],
            FORBID_ATTR: ['style', 'class', 'id', 'data-component', 'data-analytics-module'],
        });

        const cleanedReadabilityText = this.postCleanText(readabilityContent);
        const cleanedReadabilityTitle = this.postCleanText(readabilityTitle);
        const cleanedHtml = this.postCleanText(sanitizedHtml);

        let finalTitle = cleanedReadabilityTitle.length > 5 ? cleanedReadabilityTitle : structuredResult.title || '';
        let finalContent = cleanedReadabilityText;
        let finalHtml = cleanedHtml;
        const finalDate = structuredResult.publishedDate || this.extractPublishedDate(dom.window.document);

        const readWordCount = finalContent.split(/\s+/).length;

        if (structuredResult.hasContent) {
            const isReadabilityTeaser =
                metadataResult.expectedWordCount > 500 && readWordCount < metadataResult.expectedWordCount * 0.3;
            const isJsonLdBetter = structuredResult.content.length > finalContent.length + 500;
            const isReadabilityEmpty = finalContent.length < 250;

            const allowUpgrade = !visualPaywallDetected;

            if (allowUpgrade && (isReadabilityTeaser || isJsonLdBetter || isReadabilityEmpty)) {
                console.log(
                    `✅ [HYBRID] Upgrading content using JSON-LD. (Teaser: ${isReadabilityTeaser}, Better: ${isJsonLdBetter}, Empty: ${isReadabilityEmpty})`,
                );

                finalContent = structuredResult.content;

                if (finalTitle.length < 5) finalTitle = structuredResult.title;

                if (isReadabilityTeaser || isReadabilityEmpty || finalHtml.length < 500) {
                    console.log('✅ [HYBRID] Generating HTML from JSON-LD text (Readability HTML was unusable)');
                    finalHtml = structuredResult.contentHtml;
                }
            } else if (visualPaywallDetected && isJsonLdBetter) {
                console.log(
                    `🛑 [HYBRID] Paywall detected. Ignoring better JSON-LD content (${structuredResult.content.length} chars) to ensure compliance.`,
                );
            }
        }

        let hasContent = Boolean(finalContent && finalContent.trim().length > 250 && finalTitle && finalTitle.trim().length > 5);

        const actualWordCount = finalContent.split(/\s+/).filter((w) => w.length > 0).length;
        const readingTime = metadataResult.expectedReadingTime || Math.max(1, Math.ceil(actualWordCount / 225));

        if (hasContent && metadataResult.expectedWordCount > 500) {
            if (actualWordCount < metadataResult.expectedWordCount * 0.3) {
                console.log(
                    `⚠️ [EXTRACTION] Word count mismatch! Expected ${metadataResult.expectedWordCount}, got ${actualWordCount}. Ratio: ${(actualWordCount / metadataResult.expectedWordCount).toFixed(2)}`,
                );
                hasContent = false;
            }
        }

        if (hasContent) {
            const paywallKeywords = [
                'subscribe to read',
                'subscribe for full access',
                'log in to continue',
                'already a subscriber',
                'you have reached your limit',
                'this article is for subscribers only',
                'join now to read',
                'create an account to read',
                'start your free trial',
                'unlock this article',
                'subscribe to the times',
                'read as many articles as you like',
                'register to keep reading',
                'subscribe to continue',
                'to continue reading',
                'sign up for',
            ];

            const lowerContent = finalContent.toLowerCase();
            const lastChunk = lowerContent.slice(-1500);

            const detectedKeyword = paywallKeywords.find((kw) => lastChunk.includes(kw));
            if (detectedKeyword) {
                console.log(`⚠️ [EXTRACTION] Paywall keyword detected in content tail: "${detectedKeyword}". Marking hasContent=false.`);
                hasContent = false;
            }
        }

        return {
            title: finalTitle,
            excerpt: this.createExcerpt(article?.excerpt || finalContent),
            content: finalContent,
            contentHtml: finalHtml,
            author: structuredResult.author || article?.byline || undefined,
            imageUrl: this.extractImageUrl(dom.window.document),
            readingTime: readingTime,
            publishedDate: finalDate,
            hasContent: !!hasContent,
        };
    }

    private extractMetadataOnly(doc: Document): { expectedWordCount: number; expectedReadingTime?: number } {
        let expectedWordCount = 0;
        let expectedReadingTime: number | undefined = undefined;
        try {
            const jsonLdScripts = doc.querySelectorAll('script[type="application/ld+json"]');
            for (let i = 0; i < jsonLdScripts.length; i++) {
                const script = jsonLdScripts[i];
                const text = script.textContent || '';
                if (!text.includes('wordCount') && !text.includes('timeRequired')) continue;

                try {
                    const data = JSON.parse(text);
                    const items = Array.isArray(data) ? data : [data];
                    for (const item of items) {
                        if (item.wordCount) {
                            const count = parseInt(item.wordCount, 10);
                            if (!isNaN(count) && count > expectedWordCount) {
                                expectedWordCount = count;
                            }
                        }
                        if (item.timeRequired) {
                            const match = item.timeRequired.match(/PT(\d+)([MH])/);
                            if (match) {
                                let time = parseInt(match[1], 10);
                                if (match[2] === 'H') time *= 60;
                                expectedReadingTime = time;
                            }
                        }
                    }
                } catch {
                    /* ignore malformed JSON-LD */
                }
            }
        } catch {
            /* ignore */
        }

        return { expectedWordCount, expectedReadingTime };
    }

    private extractPublishedDate(doc: Document): Date | undefined {
        const metaNames = [
            'article:published_time',
            'og:published_time',
            'pubdate',
            'publishdate',
            'timestamp',
            'date',
            'dc.date.issued',
            'datePublished',
            'datecreated',
            'dateModified',
        ];
        for (const name of metaNames) {
            const meta = doc.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
            const content = meta?.getAttribute('content');
            if (content) {
                const date = new Date(content);
                if (!isNaN(date.getTime())) return date;
            }
        }

        const timeEl = doc.querySelector('time[datetime]');
        if (timeEl) {
            const datetime = timeEl.getAttribute('datetime');
            if (datetime) {
                const date = new Date(datetime);
                if (!isNaN(date.getTime())) return date;
            }
        }

        const timeTextEl = doc.querySelector('time');
        if (timeTextEl) {
            const date = new Date(timeTextEl.textContent || '');
            if (!isNaN(date.getTime())) return date;
        }

        return undefined;
    }

    private detectVisualPaywall(doc: Document, url?: string): boolean {
        if (url) {
            const safeDomains = ['blog.google', 'google.com', 'youtube.com', 'wikipedia.org', 'github.com'];
            try {
                const hostname = new URL(url).hostname;
                if (safeDomains.some((domain) => hostname === domain || hostname.endsWith('.' + domain))) {
                    return false;
                }
            } catch {
                /* ignore invalid URLs */
            }
        }

        const paywallSelectors = [
            '[class*="paywall"]',
            '[id*="paywall"]',
            '[class*="subscription-gate"]',
            '[class*="paywall-gate"]',
            '[class*="metered-gate"]',
            '[id*="subscription-gate"]',
            '[id*="paywall-gate"]',
            '[class*="subscriber-only"]',
            '[class*="premium-content"]',
        ];

        if (doc.querySelector(paywallSelectors.join(','))) {
            return true;
        }

        const paywallKeywords = [
            'subscribe to read',
            'subscribe for full access',
            'log in to continue',
            'already a subscriber',
            'you have reached your limit',
            'this article is for subscribers only',
            'join now to read',
            'create an account to read',
            'start your free trial',
            'unlock this article',
            'subscribe to the times',
            'read as many articles as you like',
            'register to keep reading',
            'subscribe to continue',
            'to continue reading',
            'sign up for',
        ];

        const bodyText = doc.body.textContent?.toLowerCase() || '';
        const footerText = bodyText.slice(-1000);

        return paywallKeywords.some((keyword) => footerText.includes(keyword));
    }

    private extractFromStructuredData(doc: Document): ExtractedArticle {
        const jsonLdScripts = doc.querySelectorAll('script[type="application/ld+json"]');
        console.log(`🔍 [STRUCTURED] Found ${jsonLdScripts.length} JSON-LD script tags`);

        for (let i = 0; i < jsonLdScripts.length; i++) {
            const script = jsonLdScripts[i];
            try {
                let jsonText = script.textContent || '';
                console.log(`🔍 [STRUCTURED] Processing JSON-LD #${i + 1}, length: ${jsonText.length} chars`);

                jsonText = jsonText.replace(/\\\//g, '/').trim();

                console.log(`🔍 [STRUCTURED] JSON-LD preview: ${jsonText.substring(0, 200)}...`);

                const data = JSON.parse(jsonText);
                console.log(`✅ [STRUCTURED] Successfully parsed JSON-LD #${i + 1}`);

                const articles = Array.isArray(data) ? data : [data];

                for (const item of articles) {
                    console.log(`🔍 [STRUCTURED] Checking item with @type: ${item['@type']}`);

                    const isAccessibleForFree =
                        item['isAccessibleForFree'] !== false &&
                        item['isAccessibleForFree'] !== 'False' &&
                        item['isAccessibleForFree'] !== 'false';

                    if (!isAccessibleForFree) {
                        if (item['hasPart']) {
                            const parts = Array.isArray(item['hasPart']) ? item['hasPart'] : [item['hasPart']];
                            for (const part of parts) {
                                if (part['cssSelector']) {
                                    const paywallEl = doc.querySelector(part['cssSelector']);
                                    if (paywallEl) {
                                        console.log(`🔒 [STRUCTURED] Verified Paywall active via selector: ${part['cssSelector']}`);
                                        return {
                                            title: '',
                                            excerpt: '',
                                            content: '',
                                            contentHtml: '',
                                            hasContent: false,
                                        };
                                    }
                                }
                            }
                        }
                    }

                    if (item['@type'] === 'NewsArticle' || item['@type'] === 'Article') {
                        console.log('📰 [STRUCTURED] Found NewsArticle/Article in JSON-LD');

                        const headline = item.headline || item.name || '';
                        const articleBody = item.articleBody || '';
                        const description = item.description || '';
                        const datePublished = item.datePublished || item.dateCreated;

                        let author = '';
                        if (item.author) {
                            if (typeof item.author === 'string') author = item.author;
                            else if (item.author.name) author = item.author.name;
                            else if (Array.isArray(item.author) && item.author.length > 0) {
                                const names = item.author
                                    .map((a: { name?: string } | string) => (typeof a === 'string' ? a : a.name))
                                    .filter((n: unknown): n is string => typeof n === 'string');
                                author = names.join(', ');
                            }
                        }

                        console.log(`📰 [STRUCTURED] Found headline: "${headline}"`);
                        console.log(`📰 [STRUCTURED] Found articleBody: ${articleBody ? `${articleBody.length} chars` : 'none'}`);
                        console.log(`📰 [STRUCTURED] Found description: ${description ? `${description.length} chars` : 'none'}`);

                        let content = articleBody;
                        if (!content && item.text) {
                            content = item.text;
                            console.log(`📰 [STRUCTURED] Using text field: ${content.length} chars`);
                        }

                        if (!content && item.mainEntityOfPage && typeof item.mainEntityOfPage === 'object') {
                            content = item.mainEntityOfPage.articleBody || item.mainEntityOfPage.text || '';
                            if (content) {
                                console.log(`📰 [STRUCTURED] Using mainEntityOfPage content: ${content.length} chars`);
                            }
                        }

                        if (headline && (content || description)) {
                            const finalContent = content || description;
                            const cleanedTitle = this.postCleanText(headline);
                            const cleanedContent = this.postCleanText(finalContent);

                            console.log(`📰 [STRUCTURED] Cleaned title: "${cleanedTitle}" (${cleanedTitle.length} chars)`);
                            console.log(
                                `📰 [STRUCTURED] Cleaned content preview: "${cleanedContent.substring(0, 100)}..." (${cleanedContent.length} chars total)`,
                            );

                            const hasContent = cleanedTitle.length > 5 && cleanedContent.length > 250;

                            if (hasContent) {
                                console.log('✅ [STRUCTURED] Content validation passed, returning structured data result');
                                return {
                                    title: cleanedTitle,
                                    excerpt: this.createExcerpt(finalContent),
                                    content: cleanedContent,
                                    contentHtml: this.sanitizeHtmlForDisplay(finalContent),
                                    hasContent: true,
                                    publishedDate: datePublished ? new Date(datePublished) : undefined,
                                    author: author || undefined,
                                };
                            } else {
                                console.log(
                                    `⚠️ [STRUCTURED] Content validation failed - title: ${cleanedTitle.length} chars, content: ${cleanedContent.length} chars`,
                                );
                            }
                        } else {
                            console.log(`⚠️ [STRUCTURED] Missing required fields - headline: ${!!headline}, content: ${!!(content || description)}`);
                        }
                    }
                }
            } catch (error) {
                console.log(`❌ [STRUCTURED] Failed to parse JSON-LD #${i + 1}:`, (error as Error).message);
                continue;
            }
        }

        // Try microdata extraction as fallback
        console.log('🔍 [STRUCTURED] Trying microdata extraction...');
        const articleElement = doc.querySelector('[itemtype*="schema.org/Article"], [itemtype*="schema.org/NewsArticle"]');
        if (articleElement) {
            const headline = articleElement.querySelector('[itemprop="headline"]')?.textContent || '';
            const articleBody = articleElement.querySelector('[itemprop="articleBody"]')?.textContent || '';

            if (headline && articleBody) {
                const cleanedTitle = this.postCleanText(headline);
                const cleanedContent = this.postCleanText(articleBody);

                if (cleanedTitle.length > 5 && cleanedContent.length > 250) {
                    console.log('📰 [STRUCTURED] Successfully extracted from microdata');
                    return {
                        title: cleanedTitle,
                        excerpt: this.createExcerpt(articleBody),
                        content: cleanedContent,
                        contentHtml: this.sanitizeHtmlForDisplay(articleBody),
                        hasContent: true,
                    };
                }
            }
        }

        // Try JavaScript variable extraction (for sites like NY Post that put metadata in JS variables)
        console.log('🔍 [STRUCTURED] Trying JavaScript variable extraction...');
        const jsVariableResult = this.extractFromJavaScriptVariables(doc);
        if (jsVariableResult.hasContent) {
            console.log('📰 [STRUCTURED] Successfully extracted from JavaScript variables');
            return jsVariableResult;
        }

        return { title: '', excerpt: '', content: '', contentHtml: '', hasContent: false };
    }

    /**
     * Extract content from JavaScript variables embedded in the page (NY Post style)
     */
    private extractFromJavaScriptVariables(doc: Document): ExtractedArticle {
        const scripts = doc.querySelectorAll('script');

        for (const script of scripts) {
            const content = script.textContent || '';

            // Look for NY Post's ga4Dims variable
            const ga4DimsMatch = content.match(/var ga4Dims = ({[^}]+})/);
            if (ga4DimsMatch) {
                try {
                    const ga4DimsText = ga4DimsMatch[1]
                        .replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":')
                        .replace(/:\s*([^",{}]+)(?=[,}])/g, ':"$1"')
                        .replace(/"(\d+)"/g, '$1');

                    const ga4Dims = JSON.parse(ga4DimsText);
                    console.log('🔍 [STRUCTURED] Found ga4Dims data:', Object.keys(ga4Dims));

                    const title = ga4Dims.title || ga4Dims.article_title || '';
                    const wordCount = parseInt(ga4Dims.word_count) || 0;

                    console.log(`📰 [STRUCTURED] ga4Dims - title: "${title}", word_count: ${wordCount}`);

                    if (title && wordCount > 200) {
                        console.log('📰 [STRUCTURED] Found partial data in ga4Dims, but missing article body');
                    }
                } catch (error) {
                    console.log('⚠️ [STRUCTURED] Failed to parse ga4Dims:', (error as Error).message);
                }
            }

            // Look for other potential JavaScript variables with article content
            const articleBodyMatch = content.match(/articleBody\s*[:=]\s*["`']([^"`']{200,})["`']/);
            if (articleBodyMatch) {
                const articleBody = articleBodyMatch[1];
                console.log(`🔍 [STRUCTURED] Found articleBody in JavaScript: ${articleBody.length} chars`);

                const titleMatch =
                    content.match(/(?:title|headline)\s*[:=]\s*["`']([^"`']+)["`']/) || content.match(/<title>([^<]+)<\/title>/);
                const title = titleMatch ? titleMatch[1] : '';

                if (title && articleBody) {
                    const cleanedTitle = this.postCleanText(title);
                    const cleanedContent = this.postCleanText(articleBody);

                    if (cleanedTitle.length > 5 && cleanedContent.length > 250) {
                        return {
                            title: cleanedTitle,
                            excerpt: this.createExcerpt(articleBody),
                            content: cleanedContent,
                            contentHtml: this.sanitizeHtmlForDisplay(articleBody),
                            hasContent: true,
                        };
                    }
                }
            }
        }

        return { title: '', excerpt: '', content: '', contentHtml: '', hasContent: false };
    }

    /**
     * Sanitize content for HTML display. For structured data, the content is
     * usually plain text, so we need to convert it to basic HTML.
     */
    private sanitizeHtmlForDisplay(content: string): string {
        return content
            .split('\n\n')
            .map((paragraph) => paragraph.trim())
            .filter((paragraph) => paragraph.length > 0)
            .map((paragraph) => `<p>${paragraph}</p>`)
            .join('');
    }

    // --- CLEANING & HELPER FUNCTIONS ---

    /**
     * Processes a raw HTML string from an RSS feed.
     * Extracts the hero image and cleans the HTML of trackers/scripts.
     */
    processFeedHtml(rawHtml: string | undefined): { cleanHtml: string; imageUrl?: string } {
        if (!rawHtml) return { cleanHtml: '' };

        const window = new JSDOM('').window;
        const DOMPurify = createDOMPurify(window as unknown as Parameters<typeof createDOMPurify>[0]);

        const dom = new JSDOM(rawHtml);
        const doc = dom.window.document;

        let imageUrl: string | undefined;
        const images = doc.querySelectorAll('img');
        for (const img of Array.from(images)) {
            const w = parseInt(img.getAttribute('width') || '0', 10);
            const h = parseInt(img.getAttribute('height') || '0', 10);

            if ((w === 1 && h === 1) || img.src.includes('pixel') || img.src.includes('tracker')) {
                img.remove();
                continue;
            }
            if (!imageUrl && img.src) {
                imageUrl = img.src;
            }
        }

        const sanitizedHtml = DOMPurify.sanitize(doc.body.innerHTML, {
            USE_PROFILES: { html: true },
            FORBID_TAGS: ['script', 'style', 'iframe', 'form', 'input', 'object', 'embed'],
            FORBID_ATTR: ['style', 'class', 'id', 'onmouseover', 'onload', 'onerror'],
        });

        return { cleanHtml: sanitizedHtml, imageUrl };
    }

    private preCleanHtml(html: string): string {
        return html
            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
            .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
            .replace(/<nav\b[^>]*>.*?<\/nav>/gis, '')
            .replace(/<header\b[^>]*>.*?<\/header>/gis, '')
            .replace(/<footer\b[^>]*>.*?<\/footer>/gis, '');
    }

    private cleanDomForReadability(doc: Document, domainConfig?: DomainExtractionConfig): void {
        const selectorsToRemove = [
            '[class*="nav"]',
            '[class*="menu"]',
            '[class*="sidebar"]',
            '[class*="banner"]',
            '[class*="advert"]',
            '[class*="social"]',
            '[class*="share"]',
            '[class*="cookie"]',
            '[class*="popup"]',
            '[id*="nav"]',
            '[id*="menu"]',
            '[id*="sidebar"]',
            '[id*="banner"]',
            '[id*="ad"]',
            // AI Summaries & Google Overviews
            '[class*="google-summary"]',
            '[id*="google-summary"]',
            '[class*="ai-overview"]',
            '[id*="ai-overview"]',
            '[aria-label="AI Overview"]',
            '[class*="key-takeaways"]',
            '[class*="tldr"]',
            // Specific Google Blog AI Summary selector
            '[data-component="uni-ai-generated-summary"]',
            // Google Blog Author Image (in Hero Menu)
            '[data-analytics-module*="Hero Menu"] figure',
            // Reuters & News Sites Specifics
            '[class*="author-about"]',
            '[class*="about-author"]',
            '[class*="author-bio"]',
            '[class*="bio"]',
            '[class*="companies"]',
            '[class*="company-info"]',
            '[class*="summary"]',
            '[class*="article-summary"]',
            '[aria-label*="Opens new tab"]',
            'span[class*="opens-new-tab"]',
            // Additional cleaning for Reuters/News
            'figcaption',
            '[class*="caption"]',
            '[data-testid="Title"]',
            '[data-testid="Button"]',
            '[class*="read-more"]',
            '[class*="related-content"]',
            '[data-testid="key-points"]',
            '[class*="key-points"]',
        ];
        selectorsToRemove.forEach((selector) => {
            try {
                doc.querySelectorAll(selector).forEach((el) => el.remove());
            } catch {
                // Ignore invalid selectors
            }
        });

        if (domainConfig?.additionalSelectorsToRemove) {
            domainConfig.additionalSelectorsToRemove.forEach((selector) => {
                try {
                    doc.querySelectorAll(selector).forEach((el) => el.remove());
                } catch {
                    // Ignore invalid selectors
                }
            });
        }

        // Remove "Summary" / "Key Points" sections based on text content — catches
        // cases where classes/IDs are obfuscated but the visible text is "Summary".
        const potentialHeaders = Array.from(doc.querySelectorAll('h2, h3, h4, h5, h6, strong, b, div, span'));
        for (const el of potentialHeaders) {
            const text = el.textContent?.trim();
            if (text === 'Summary' || text === 'Key Points') {
                // Case 1: Header followed immediately by a list
                const next = el.nextElementSibling;
                if (next && (next.tagName === 'UL' || next.tagName === 'OL')) {
                    el.remove();
                    next.remove();
                    continue;
                }

                // Case 2: Header inside a container that is primarily a list
                const parent = el.parentElement;
                if (parent && parent.textContent && parent.textContent.length < 1000) {
                    if (parent.querySelector('ul, ol')) {
                        parent.remove();
                    }
                }
            }
        }

        // Handle standalone stock ticker links (e.g. "AAPL.O") — convert their
        // container to a span so they flow inline instead of being removed.
        const links = doc.querySelectorAll('a');
        links.forEach((link) => {
            const text = link.textContent?.trim() || '';
            if (/^\(?[A-Z]{2,6}\.[A-Z]{1,3}\)?$/.test(text)) {
                const parent = link.parentElement;
                if (parent) {
                    const parentText = parent.textContent?.trim() || '';
                    if (parentText === text) {
                        if (['DIV', 'P', 'SECTION', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(parent.tagName)) {
                            const span = doc.createElement('span');
                            span.innerHTML = parent.innerHTML;
                            parent.replaceWith(span);
                        }
                    }
                }
            }
        });

        // Remove "Opens new tab" and other clutter from text nodes
        const walker = doc.createTreeWalker(doc.body, 4 /* NodeFilter.SHOW_TEXT */);
        let node;
        while ((node = walker.nextNode())) {
            const text = node.textContent || '';

            if (text.match(/opens new tab/i)) {
                node.textContent = text.replace(/,?\s*opens new tab/gi, '');
            }

            if (text.includes('Purchase Licensing Rights')) {
                node.textContent = node.textContent?.replace(/Purchase Licensing Rights/g, '') || '';
            }

            if (text.match(/^(Item\s+\d+\s+of\s+\d+|\[\d+\/\d+\])/i) && text.length < 500) {
                node.textContent = '';
            }

            if (text.trim() === 'Companies') {
                node.textContent = '';
            }
        }

        // Convert leaf <div> elements to <p> elements. Some sites (e.g. Apple
        // Newsroom) use <div> instead of <p> for paragraphs, which Readability.js
        // cannot score reliably. This conversion fixes that. Can be disabled
        // per-domain via `skipLeafDivConversion` if it causes noise.
        if (!domainConfig?.skipLeafDivConversion) {
            const BLOCK_TAGS = new Set([
                'DIV',
                'P',
                'SECTION',
                'ARTICLE',
                'BLOCKQUOTE',
                'TABLE',
                'UL',
                'OL',
                'LI',
                'H1',
                'H2',
                'H3',
                'H4',
                'H5',
                'H6',
                'HEADER',
                'FOOTER',
                'NAV',
                'ASIDE',
                'FIGURE',
                'FIGCAPTION',
                'PRE',
                'FORM',
                'FIELDSET',
                'DL',
                'DT',
                'DD',
            ]);
            const allDivs = Array.from(doc.querySelectorAll('div'));
            for (const div of allDivs) {
                const hasBlockChild = Array.from(div.children).some((child) => BLOCK_TAGS.has(child.tagName));
                if (hasBlockChild) continue;
                if ((div.textContent?.trim().length ?? 0) < 25) continue;
                const p = doc.createElement('p');
                p.innerHTML = div.innerHTML;
                div.replaceWith(p);
            }
        }
    }

    private postCleanText(text: string): string {
        if (!text) return '';

        const patternsToRemove = [
            /Your browser does not support the audio element\.?/gi,
            /Listen to article/gi,
            /This content is generated by Google AI\.? Generative AI is experimental\.?/gi,
            /\[\[duration\]\] minutes/gi,
            /Copyright © \d{4} .*/gi,
            /All rights reserved\.?/gi,
            /Read more at .*/gi,
            /Subscribe to our newsletter/gi,
            /Share this article/gi,
            /Skip to (main )?content/gi,
            /Skip to navigation/gi,
        ];

        let cleanedText = text;
        for (const pattern of patternsToRemove) {
            cleanedText = cleanedText.replace(pattern, ' ');
        }

        return cleanedText.replace(/\s+/g, ' ').trim();
    }

    private createExcerpt(text: string): string {
        if (!text) return '';
        const cleaned = this.postCleanText(text);
        if (cleaned.length > 300) {
            return cleaned.substring(0, 300).replace(/\s+\S*$/, '...');
        }
        return cleaned;
    }

    private extractImageUrl(doc: Document): string | undefined {
        const ogImage = doc.querySelector('meta[property="og:image"]')?.getAttribute('content');
        if (ogImage) return ogImage;

        const twitterImage = doc.querySelector('meta[name="twitter:image"]')?.getAttribute('content');
        if (twitterImage) return twitterImage;

        const firstImage = doc.querySelector('article img, main img');
        if (firstImage) {
            const src = firstImage.getAttribute('src');
            if (src) return new URL(src, doc.baseURI).href;
        }
        return undefined;
    }
}
