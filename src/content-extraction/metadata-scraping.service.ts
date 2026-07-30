import { Injectable } from '@nestjs/common';
import axios from 'axios';
import * as cheerio from 'cheerio';

export interface ScrapedMetadata {
    siteName?: string;
    siteIcon?: string;
    ogImage?: string;
    ogDescription?: string;
    themeColor?: string;
    ogType?: string;
    contentType?: string;
    title?: string;
    description?: string;
    author?: string;
    publishDate?: string;
    [key: string]: string | undefined;
}

interface ExtractionRule {
    type: 'meta' | 'selector' | 'static';
    attr?: string;
    val?: string;
    selector?: string;
    method?: 'text' | 'attr';
    attrName?: string;
    value?: string;
}

/**
 * Ports lb-laterleaf/src/services/metadata-scraping.service.ts.
 */
@Injectable()
export class MetadataScrapingService {
    private readonly METADATA_RULES: Record<string, ExtractionRule[]> = {
        ogImage: [
            { type: 'meta', attr: 'property', val: 'og:image' },
            { type: 'meta', attr: 'name', val: 'twitter:image' },
            { type: 'meta', attr: 'property', val: 'twitter:image' },
        ],
        ogDescription: [
            { type: 'meta', attr: 'property', val: 'og:description' },
            { type: 'meta', attr: 'name', val: 'twitter:description' },
            { type: 'meta', attr: 'property', val: 'twitter:description' },
            { type: 'meta', attr: 'name', val: 'description' },
        ],
        themeColor: [
            { type: 'meta', attr: 'name', val: 'theme-color' },
            { type: 'meta', attr: 'name', val: 'msapplication-TileColor' },
        ],
        ogType: [
            { type: 'meta', attr: 'property', val: 'og:type' },
            { type: 'static', value: 'website' },
        ],
        title: [
            { type: 'meta', attr: 'property', val: 'og:title' },
            { type: 'meta', attr: 'name', val: 'twitter:title' },
            { type: 'meta', attr: 'property', val: 'twitter:title' },
            { type: 'selector', selector: 'title', method: 'text' },
        ],
        author: [
            { type: 'meta', attr: 'name', val: 'author' },
            { type: 'meta', attr: 'property', val: 'article:author' },
            { type: 'meta', attr: 'name', val: 'twitter:creator' },
            { type: 'meta', attr: 'name', val: 'parsely-author' },
            { type: 'meta', attr: 'name', val: 'byl' },
            { type: 'meta', attr: 'property', val: 'og:article:author' },
            { type: 'selector', selector: '[rel="author"]', method: 'text' },
            { type: 'selector', selector: '.author-name', method: 'text' },
            { type: 'selector', selector: '.byline', method: 'text' },
            { type: 'selector', selector: '.author', method: 'text' },
        ],
    };

    async scrapeMetadata(url: string, htmlContent?: string): Promise<ScrapedMetadata> {
        try {
            console.log(`Scraping metadata for: ${url} ${htmlContent ? '(using provided HTML)' : ''}`);

            let html: string;

            if (htmlContent) {
                html = htmlContent;
            } else {
                const response = await axios.get(url, {
                    timeout: 10000,
                    headers: {
                        'User-Agent':
                            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.5',
                        'Accept-Encoding': 'gzip, deflate',
                        Connection: 'keep-alive',
                    },
                });
                html = response.data;
            }

            const $ = cheerio.load(html);
            const urlObj = new URL(url);
            const baseUrl = `${urlObj.protocol}//${urlObj.host}`;

            const metadata: ScrapedMetadata = {};

            metadata.siteName =
                this.getMetaContent($, 'property', 'og:site_name') ||
                this.getMetaContent($, 'name', 'application-name') ||
                $('title').text()?.split(' - ').pop()?.split(' | ').pop()?.trim() ||
                urlObj.hostname.replace(/^www\./, '');

            const iconSelectors = [
                'link[rel="apple-touch-icon"]',
                'link[rel="icon"]',
                'link[rel="shortcut icon"]',
                'link[rel="favicon"]',
            ];

            for (const selector of iconSelectors) {
                const iconHref = $(selector).attr('href');
                if (iconHref) {
                    metadata.siteIcon = this.resolveUrl(iconHref, baseUrl);
                    break;
                }
            }

            if (!metadata.siteIcon) {
                metadata.siteIcon = `${baseUrl}/favicon.ico`;
            }

            for (const [key, rules] of Object.entries(this.METADATA_RULES)) {
                for (const rule of rules) {
                    let value: string | undefined;

                    if (rule.type === 'meta') {
                        value = this.getMetaContent($, rule.attr!, rule.val!);
                    } else if (rule.type === 'selector') {
                        const el = $(rule.selector!).first();
                        if (rule.method === 'attr' && rule.attrName) {
                            value = el.attr(rule.attrName);
                        } else {
                            value = el.text();
                        }
                    } else if (rule.type === 'static') {
                        value = rule.value;
                    }

                    if (value?.trim()) {
                        value = value.trim();
                        if (key === 'author' && rule.type === 'meta' && rule.val === 'twitter:creator') {
                            value = value.replace('@', '');
                        }
                        if (key === 'ogImage') {
                            value = this.resolveUrl(value, baseUrl);
                        }
                        metadata[key] = value;
                        break;
                    }
                }
            }

            const publishDateSelectors = [
                'meta[property="article:published_time"]',
                'meta[name="publish_date"]',
                'meta[name="date"]',
                'meta[property="og:updated_time"]',
                'time[datetime]',
                'time[pubdate]',
            ];

            for (const selector of publishDateSelectors) {
                const dateValue = $(selector).attr('content') || $(selector).attr('datetime');
                if (dateValue) {
                    const parsedDate = new Date(dateValue);
                    if (!isNaN(parsedDate.getTime())) {
                        metadata.publishDate = parsedDate.toISOString();
                        break;
                    }
                }
            }

            metadata.contentType = this.determineContentType(url, metadata.ogType);

            console.log(`Successfully scraped metadata for ${url}:`, metadata);
            return metadata;
        } catch (error) {
            console.error(`Failed to scrape metadata for ${url}:`, error);

            try {
                const urlObj = new URL(url);
                return {
                    siteName: urlObj.hostname.replace(/^www\./, ''),
                    siteIcon: `${urlObj.protocol}//${urlObj.host}/favicon.ico`,
                    ogType: 'website',
                };
            } catch {
                return {};
            }
        }
    }

    private determineContentType(url: string, ogType?: string): string {
        if (
            ogType?.startsWith('video') ||
            url.includes('youtube.com/watch') ||
            url.includes('youtu.be/') ||
            url.includes('vimeo.com/')
        ) {
            return 'video';
        }

        if (
            ogType?.startsWith('music') ||
            ogType === 'audio' ||
            url.includes('spotify.com') ||
            url.includes('soundcloud.com') ||
            url.includes('podcasts.apple.com')
        ) {
            return 'audio';
        }

        if ((url.includes('twitter.com') || url.includes('x.com')) && url.includes('/status/')) {
            return 'tweet';
        }

        return 'article';
    }

    private getMetaContent($: cheerio.CheerioAPI, attribute: string, value: string): string | undefined {
        const content = $(`meta[${attribute}="${value}"]`).attr('content');
        return content?.trim() || undefined;
    }

    private resolveUrl(url: string, baseUrl: string): string {
        try {
            return new URL(url, baseUrl).toString();
        } catch {
            return url;
        }
    }
}
