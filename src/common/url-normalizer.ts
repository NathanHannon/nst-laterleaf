/**
 * Ports lb-laterleaf/src/utils/url-normalizer.ts.
 *
 * Normalizes URLs to prevent duplicate articles caused by tracking
 * parameters, social media parameters, and other non-essential URL
 * variations (e.g. `?utm_source=twitter` vs `?utm_source=facebook`).
 */
export class UrlNormalizer {
    /**
     * Normalizes a URL by removing all query parameters and the fragment.
     * For article-saving apps like LaterLeaf, query parameters are almost
     * always optional navigation context — the actual content comes from
     * extraction, not URL parameters — so removing all of them maximizes
     * deduplication while maintaining article uniqueness.
     */
    static normalize(url: string): string {
        try {
            const urlObj = new URL(url);

            urlObj.search = '';
            urlObj.hash = '';

            if (urlObj.pathname.length > 1 && urlObj.pathname.endsWith('/')) {
                urlObj.pathname = urlObj.pathname.slice(0, -1);
            }

            urlObj.hostname = urlObj.hostname.toLowerCase();

            const normalizedUrl = urlObj.toString();

            if (normalizedUrl !== url) {
                console.log(`🧹 [URL-NORMALIZE] ${url} → ${normalizedUrl}`);
            }

            return normalizedUrl;
        } catch (error) {
            console.warn(`⚠️ [URL-NORMALIZE] Failed to normalize URL: ${url}`, error);
            return url;
        }
    }

    /**
     * Checks if two URLs would be considered the same after normalization.
     */
    static areEquivalent(url1: string, url2: string): boolean {
        try {
            return this.normalize(url1) === this.normalize(url2);
        } catch {
            return url1 === url2;
        }
    }

    /**
     * Gets the domain from a normalized URL (useful for analytics).
     */
    static getDomain(url: string): string | null {
        try {
            return new URL(this.normalize(url)).hostname;
        } catch {
            return null;
        }
    }
}
