import { BadRequestException, Body, Controller, Post, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ClerkAuthGuard } from '../auth/guards/clerk-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { ClerkUserProfile } from '../auth/interfaces/clerk-user-profile.interface';
import { UsersService } from '../users/users.service';

interface ParsedBookmark {
    url: string;
    title?: string;
    tags?: string[];
    dateAdded?: string;
}

/**
 * Ports lb-laterleaf/src/controllers/import.controller.ts. Parses an
 * exported file from Pocket, Instapaper, or generic HTML/CSV/JSON bookmarks
 * and returns the extracted URLs — the frontend then imports them one by
 * one via the existing `POST /articles/import` endpoint (dedup/moderation).
 */
@UseGuards(ClerkAuthGuard)
@Controller('import')
export class ImportController {
    constructor(private readonly usersService: UsersService) { }

    private async getUser(currentUser: ClerkUserProfile) {
        const user = await this.usersService.findByClerkId(currentUser.clerkId);
        if (!user?.id) {
            throw new UnauthorizedException('User not found.');
        }
        return user;
    }

    @Post('parse')
    async parseImportFile(
        @Body() body: { content: string; format: 'html' | 'csv' | 'json' },
        @CurrentUser() currentUser: ClerkUserProfile,
    ): Promise<{ bookmarks: ParsedBookmark[]; source: string; total: number }> {
        // Validate the user is authenticated.
        await this.getUser(currentUser);

        const { content, format } = body;

        if (!content || content.trim().length === 0) {
            throw new BadRequestException('File content is empty');
        }

        let bookmarks: ParsedBookmark[];
        let source: string;

        switch (format) {
            case 'html':
                ({ bookmarks, source } = this.parseHtmlBookmarks(content));
                break;
            case 'csv':
                ({ bookmarks, source } = this.parseCsvBookmarks(content));
                break;
            case 'json':
                ({ bookmarks, source } = this.parseJsonBookmarks(content));
                break;
            default:
                throw new BadRequestException(`Unsupported format: ${format}`);
        }

        // Deduplicate by URL.
        const seen = new Set<string>();
        bookmarks = bookmarks.filter((b) => {
            if (!b.url || seen.has(b.url)) return false;
            seen.add(b.url);
            return true;
        });

        return { bookmarks, source, total: bookmarks.length };
    }

    // ─── HTML (Pocket, Instapaper, Browser Bookmarks) ───

    private parseHtmlBookmarks(content: string): { bookmarks: ParsedBookmark[]; source: string } {
        const bookmarks: ParsedBookmark[] = [];
        let source = 'HTML Bookmarks';

        if (content.includes('Pocket') || content.includes('getpocket.com')) {
            source = 'Pocket';
        } else if (content.includes('Instapaper')) {
            source = 'Instapaper';
        } else if (content.includes('NETSCAPE-Bookmark-file')) {
            source = 'Browser Bookmarks';
        }

        const linkRegex = /<A\s+[^>]*HREF="([^"]+)"[^>]*>([^<]*)<\/A>/gi;
        const tagRegex = /TAGS="([^"]*)"/i;
        const timeRegex = /TIME_ADDED="(\d+)"|ADD_DATE="(\d+)"/i;

        let match;
        while ((match = linkRegex.exec(content)) !== null) {
            const fullTag = match[0];
            const url = match[1];
            const title = match[2]?.trim() || undefined;

            if (!url.startsWith('http://') && !url.startsWith('https://')) continue;

            const tagMatch = tagRegex.exec(fullTag);
            const tags = tagMatch?.[1]?.split(',').map((t) => t.trim()).filter(Boolean) || undefined;

            const timeMatch = timeRegex.exec(fullTag);
            const timestamp = timeMatch?.[1] || timeMatch?.[2];
            const dateAdded = timestamp ? new Date(parseInt(timestamp) * 1000).toISOString() : undefined;

            bookmarks.push({ url, title, tags, dateAdded });
        }

        return { bookmarks, source };
    }

    // ─── CSV (Instapaper, generic) ───

    private parseCsvBookmarks(content: string): { bookmarks: ParsedBookmark[]; source: string } {
        const bookmarks: ParsedBookmark[] = [];
        let source = 'CSV';

        const lines = content.split('\n').filter((l) => l.trim().length > 0);
        if (lines.length < 2) {
            return { bookmarks, source };
        }

        const header = lines[0].toLowerCase();

        // Detect Instapaper CSV: URL,Title,Selection,Folder,Timestamp
        if (header.includes('url') && header.includes('folder')) {
            source = 'Instapaper';
        }

        const cols = this.parseCsvRow(lines[0]).map((c) => c.toLowerCase().trim());
        const urlIdx = cols.findIndex((c) => c === 'url');
        const titleIdx = cols.findIndex((c) => c === 'title');
        const tagsIdx = cols.findIndex((c) => c === 'tags');
        const dateIdx = cols.findIndex(
            (c) => c === 'timestamp' || c === 'date added' || c === 'dateadded' || c === 'date',
        );

        // If no URL column header, try first column.
        const effectiveUrlIdx = urlIdx >= 0 ? urlIdx : 0;

        for (let i = 1; i < lines.length; i++) {
            const fields = this.parseCsvRow(lines[i]);
            const url = fields[effectiveUrlIdx]?.trim();
            if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) continue;

            bookmarks.push({
                url,
                title: titleIdx >= 0 ? fields[titleIdx]?.trim() : undefined,
                tags: tagsIdx >= 0 ? fields[tagsIdx]?.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
                dateAdded: dateIdx >= 0 ? fields[dateIdx]?.trim() : undefined,
            });
        }

        return { bookmarks, source };
    }

    /** Simple CSV row parser handling quoted fields. */
    private parseCsvRow(row: string): string[] {
        const fields: string[] = [];
        let current = '';
        let inQuotes = false;

        for (let i = 0; i < row.length; i++) {
            const ch = row[i];
            if (ch === '"') {
                if (inQuotes && row[i + 1] === '"') {
                    current += '"';
                    i++;
                } else {
                    inQuotes = !inQuotes;
                }
            } else if (ch === ',' && !inQuotes) {
                fields.push(current);
                current = '';
            } else {
                current += ch;
            }
        }
        fields.push(current);
        return fields;
    }

    // ─── JSON (generic, LaterLeaf export, Pocket API export) ───

    private parseJsonBookmarks(content: string): { bookmarks: ParsedBookmark[]; source: string } {
        let data: any;
        try {
            data = JSON.parse(content);
        } catch {
            throw new BadRequestException('Invalid JSON content');
        }

        let source = 'JSON';
        const bookmarks: ParsedBookmark[] = [];

        // LaterLeaf's own JSON export.
        if (Array.isArray(data) && data[0]?.url) {
            source = 'LaterLeaf';
            for (const item of data) {
                if (!item.url) continue;
                bookmarks.push({
                    url: item.url,
                    title: item.title,
                    tags: item.tags,
                    dateAdded: item.dateAdded || item.createdAt,
                });
            }
            return { bookmarks, source };
        }

        // Pocket JSON API export (object keyed by ID).
        if (typeof data === 'object' && !Array.isArray(data)) {
            const list = data.list || data;
            if (typeof list === 'object') {
                const values = Object.values(list) as any[];
                if (values.length > 0 && values[0]?.resolved_url) {
                    source = 'Pocket';
                    for (const item of values) {
                        const url = item.resolved_url || item.given_url;
                        if (!url) continue;
                        bookmarks.push({
                            url,
                            title: item.resolved_title || item.given_title,
                            tags: item.tags ? Object.keys(item.tags) : undefined,
                            dateAdded: item.time_added
                                ? new Date(parseInt(item.time_added) * 1000).toISOString()
                                : undefined,
                        });
                    }
                    return { bookmarks, source };
                }
            }
        }

        // Generic: array of objects with a url/link field.
        const items = Array.isArray(data) ? data : [];
        for (const item of items) {
            const url = item.url || item.link || item.href;
            if (!url) continue;
            bookmarks.push({
                url,
                title: item.title || item.name,
                tags: item.tags,
                dateAdded: item.dateAdded || item.date || item.created,
            });
        }

        return { bookmarks, source };
    }
}
