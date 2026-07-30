import { Injectable } from '@nestjs/common';
import parseRobots from 'robots-parser';
import { LATERLEAF_BOT_USER_AGENT } from './utils/scraping-constants';

interface Robots {
    isAllowed(url: string, ua?: string): boolean | undefined;
    getSitemap?: () => string | undefined;
}

/**
 * Nest provider scope) to maintain the in-memory robots.txt cache, matching
 * the original's `BindingScope.SINGLETON`.
 */
@Injectable()
export class RobotsTxtService {
    private cache = new Map<string, Robots>();

    async isScrapingAllowed(url: string): Promise<boolean> {
        try {
            const urlObject = new URL(url);
            const robotsUrl = `${urlObject.protocol}//${urlObject.host}/robots.txt`;

            let robots = this.cache.get(robotsUrl);

            if (!robots) {
                console.log(`🤖 [ROBOTS] Fetching robots.txt from: ${robotsUrl}`);
                try {
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 5000);
                    const response = await fetch(robotsUrl, {
                        headers: { 'User-Agent': LATERLEAF_BOT_USER_AGENT },
                        signal: controller.signal,
                    }).finally(() => clearTimeout(timeoutId));

                    if (response.ok) {
                        const robotsTxtContent = await response.text();
                        const parsedRobots = parseRobots(robotsUrl, robotsTxtContent);
                        if (parsedRobots) {
                            robots = parsedRobots;
                            this.cache.set(robotsUrl, robots);
                        }
                    }
                } catch (fetchError) {
                    console.error(`⚠️ [ROBOTS] Could not fetch robots.txt at ${robotsUrl}:`, fetchError.message);
                }

                if (!robots) {
                    console.log(`⚠️ [ROBOTS] No valid robots.txt found or accessible at ${robotsUrl}. Assuming allowed.`);
                    robots = {
                        isAllowed: () => true,
                    };
                    this.cache.set(robotsUrl, robots);
                }
            }

            const isAllowed = robots.isAllowed(url, LATERLEAF_BOT_USER_AGENT);
            if (isAllowed === false) {
                console.log(
                    `🚫 [ROBOTS] Scraping disallowed for ${url} by robots.txt for user-agent '${LATERLEAF_BOT_USER_AGENT}'`,
                );
                return false;
            }

            return true;
        } catch (error) {
            console.error(`❌ [ROBOTS] Error processing robots.txt for ${url}:`, error.message);
            return true;
        }
    }
}
