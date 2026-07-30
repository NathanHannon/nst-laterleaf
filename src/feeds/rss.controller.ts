import * as crypto from 'crypto';
import {
    Controller,
    ForbiddenException,
    Get,
    InternalServerErrorException,
    NotFoundException,
    Param,
    Query,
    Req,
    Res,
    UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { ClerkAuthGuard } from '../auth/guards/clerk-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { ClerkUserProfile } from '../auth/interfaces/clerk-user-profile.interface';
import { UsersService } from '../users/users.service';
import { UserArticlesService } from '../articles/user-articles.service';
import { ArticlesService } from '../articles/articles.service';

/**
 * Mirrors lb-laterleaf/src/controllers/rss.controller.ts. Generates a
 * personal podcast RSS feed from a Pro user's saved articles that have
 * generated audio (`UserArticle.audioLocation`).
 */
@Controller('rss')
export class RssController {
    constructor(
        private readonly usersService: UsersService,
        private readonly userArticlesService: UserArticlesService,
        private readonly articlesService: ArticlesService,
        private readonly configService: ConfigService,
    ) { }

    private getFeedTokenSecret(): string {
        const secret =
            this.configService.get<string>('RSS_FEED_TOKEN_SECRET') ??
            this.configService.get<string>('CLERK_WEBHOOK_SECRET') ??
            '';

        if (!secret) {
            throw new InternalServerErrorException('RSS feed token secret is not configured.');
        }

        return secret;
    }

    private createFeedToken(clerkId: string): string {
        return crypto.createHmac('sha256', this.getFeedTokenSecret()).update(clerkId).digest('hex');
    }

    private isValidFeedToken(clerkId: string, token?: string): boolean {
        if (!token) {
            return false;
        }

        const expectedToken = this.createFeedToken(clerkId);
        const provided = Buffer.from(token);
        const expected = Buffer.from(expectedToken);

        if (provided.length !== expected.length) {
            return false;
        }

        return crypto.timingSafeEqual(provided, expected);
    }

    private getPodcastMediaBaseUrl(): string {
        const configuredBaseUrl =
            this.configService.get<string>('PODCAST_MEDIA_BASE_URL') ??
            this.configService.get<string>('CF_PUBLIC_URL') ??
            'https://media.laterleaf.com/laterleaf-audio-generation';

        return configuredBaseUrl.replace(/\/$/, '');
    }

    private buildPodcastAudioUrl(userId: string, articleId: string, audioLocation?: string): string {
        const mediaBaseUrl = this.getPodcastMediaBaseUrl();
        const defaultPath = `podcasts/${encodeURIComponent(userId)}/${encodeURIComponent(articleId)}`;

        if (!audioLocation || !audioLocation.trim()) {
            return `${mediaBaseUrl}/${defaultPath}`;
        }

        const location = audioLocation.trim();

        // If we have a full URL, normalize to the configured media base while preserving key suffix.
        if (/^https?:\/\//i.test(location)) {
            try {
                const { pathname } = new URL(location);
                const normalizedPath = pathname.replace(/^\/+/, '');
                const podcastsIndex = normalizedPath.indexOf('podcasts/');
                if (podcastsIndex >= 0) {
                    const suffix = normalizedPath.slice(podcastsIndex);
                    return `${mediaBaseUrl}/${suffix}`;
                }
                return location;
            } catch {
                return location;
            }
        }

        const normalizedPath = location.replace(/^\/+/, '');
        if (normalizedPath.startsWith('podcasts/')) {
            return `${mediaBaseUrl}/${normalizedPath}`;
        }

        // Unknown relative format: preserve backward compatibility.
        return location;
    }

    @UseGuards(ClerkAuthGuard)
    @Get('podcast/feed-url')
    async getCurrentUserPodcastFeedUrl(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Req() req: Request,
    ): Promise<{ url: string }> {
        const clerkId = currentUser.clerkId;
        const user = await this.usersService.findByClerkId(clerkId);
        const isAdmin = currentUser.publicMetadata?.role === 'admin';

        if (!user) {
            throw new NotFoundException('User not found.');
        }

        if (!user.isPro && !isAdmin) {
            throw new ForbiddenException('Pro subscription required for podcast feed access.');
        }

        const token = this.createFeedToken(clerkId);
        const forwardedProto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim();
        const protocol = forwardedProto || req.protocol || 'http';
        const host = req.get('host');

        if (!host) {
            throw new InternalServerErrorException('Unable to determine feed host.');
        }

        const configuredBaseUrl =
            this.configService.get<string>('BACKEND_PUBLIC_URL')?.replace(/\/$/, '') || `${protocol}://${host}`;
        const apiBaseUrl = /\/api$/i.test(configuredBaseUrl) ? configuredBaseUrl : `${configuredBaseUrl}/api`;
        const url = `${apiBaseUrl}/rss/podcast/${encodeURIComponent(clerkId)}.xml?token=${token}`;

        return { url };
    }

    @Get('podcast/:clerkId.xml')
    async getPersonalPodcastFeed(
        @Param('clerkId') clerkId: string,
        @Query('token') token: string | undefined,
        @Res({ passthrough: false }) res: Response,
    ): Promise<void> {
        if (!this.isValidFeedToken(clerkId, token)) {
            throw new ForbiddenException('Invalid or missing podcast feed token.');
        }

        // 1. Validate user exists
        const user = await this.usersService.findByClerkId(clerkId);

        if (!user || !user.isPro) {
            res.status(404).send('Feed not found or inactive subscription.');
            return;
        }

        // 2. Fetch all user articles that have audio
        const userArticles = await this.userArticlesService.findAllForUser(user.id, {
            order: { updatedAt: 'DESC' },
            take: 100, // Reasonable limit for a podcast feed
        });

        const articleIds = userArticles.map((ua) => ua.articleId).filter((id): id is string => Boolean(id));
        const articles = await this.articlesService.findByIds(articleIds);
        const articleMap = new Map(articles.map((article) => [article.id, article]));

        const podcastEpisodes = userArticles.filter((ua) => {
            const originalArticle = ua.articleId ? articleMap.get(ua.articleId) : undefined;
            return Boolean((ua.audioLocation && ua.audioLocation.trim().length > 0) || originalArticle?.id);
        });

        // 3. Build XML
        const feedTitle = 'My LaterLeaf Podcast';
        const feedDescription = "Your personal podcast feed generated by LaterLeaf's AI.";
        const feedUrl = `https://laterleaf.com/`; // Update with actual host if necessary

        const escapeXml = (unsafe: string) => {
            if (!unsafe) return '';
            return unsafe.replace(/[<>&'"]/g, (c) => {
                switch (c) {
                    case '<':
                        return '&lt;';
                    case '>':
                        return '&gt;';
                    case '&':
                        return '&amp;';
                    case "'":
                        return '&apos;';
                    case '"':
                        return '&quot;';
                    default:
                        return c;
                }
            });
        };

        let xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${escapeXml(feedTitle)}</title>
    <description>${escapeXml(feedDescription)}</description>
    <link>${escapeXml(feedUrl)}</link>
    <language>en-us</language>
    <itunes:author>LaterLeaf Personal Feed</itunes:author>
    <itunes:summary>${escapeXml(feedDescription)}</itunes:summary>
    <itunes:owner>
      <itunes:name>LaterLeaf AI</itunes:name>
      <itunes:email>support@laterleaf.com</itunes:email>
    </itunes:owner>
    <itunes:image href="https://laterleaf.com/logo512.png" />
    <itunes:category text="Technology" />
`;

        // Generate items
        for (const ua of podcastEpisodes) {
            const originalArticle = ua.articleId ? articleMap.get(ua.articleId) : undefined;
            if (!originalArticle) continue;

            const title = originalArticle.title || 'Untitled Article';
            const description = ua.summary || originalArticle.excerpt || 'An AI-generated discussion about this saved article.';
            const pubDate = new Date(ua.updatedAt || new Date()).toUTCString();
            const resolvedAudioUrl = this.buildPodcastAudioUrl(user.id, originalArticle.id, ua.audioLocation);
            const encodedAudioUrl = escapeXml(resolvedAudioUrl);

            // Default to 15MB if file size is not known
            const length = 15000000;

            // Simple guid to uniquely identify the item in RSS readers
            const guid = ua.id || `laterleaf-${originalArticle.id}`;

            xml += `
    <item>
      <title>${escapeXml(title)}</title>
      <description>${escapeXml(description)}</description>
      <pubDate>${pubDate}</pubDate>
      <guid isPermaLink="false">${escapeXml(guid)}</guid>
      <enclosure url="${encodedAudioUrl}" type="audio/mpeg" length="${length}" />
      <itunes:duration>00:05:00</itunes:duration>
      <itunes:explicit>false</itunes:explicit>
      <link>${escapeXml(originalArticle.url || feedUrl)}</link>
    </item>`;
        }
        xml += `
  </channel>
</rss>`;

        res.setHeader('Content-Type', 'application/xml');
        res.status(200).send(xml);
    }
}
