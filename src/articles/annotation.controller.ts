import {
    Body,
    Controller,
    Delete,
    Get,
    NotFoundException,
    Param,
    Patch,
    Post,
    UnauthorizedException,
    UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ClerkAuthGuard } from '../auth/guards/clerk-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { ClerkUserProfile } from '../auth/interfaces/clerk-user-profile.interface';
import { UsersService } from '../users/users.service';
import { UserArticlesService } from './user-articles.service';
import type { Highlight } from './entities/user-article.entity';

/**
 * Ports lb-laterleaf/src/controllers/annotation.controller.ts. Operates
 * directly on the `UserArticle.highlights` jsonb array.
 */
@UseGuards(ClerkAuthGuard)
@Controller('articles')
export class AnnotationController {
    constructor(
        private readonly usersService: UsersService,
        private readonly userArticlesService: UserArticlesService,
    ) { }

    @Get(':id/highlights')
    async getHighlights(
        @Param('id') id: string,
        @CurrentUser() currentUser: ClerkUserProfile,
    ): Promise<{ highlights: Highlight[] }> {
        const ua = await this.getUserArticle(currentUser, id);
        return { highlights: ua.highlights || [] };
    }

    @Post(':id/highlights')
    async createHighlight(
        @Param('id') id: string,
        @Body() body: { text: string; note?: string; color?: string },
        @CurrentUser() currentUser: ClerkUserProfile,
    ): Promise<{ highlight: Highlight }> {
        const ua = await this.getUserArticle(currentUser, id);

        const highlight: Highlight = {
            id: randomUUID(),
            text: body.text,
            note: body.note,
            color: body.color || 'yellow',
            createdAt: new Date().toISOString(),
        };

        const existing = ua.highlights || [];
        await this.userArticlesService.updateById(ua.id, {
            highlights: [...existing, highlight],
        });

        return { highlight };
    }

    @Patch(':id/highlights/:highlightId')
    async updateHighlight(
        @Param('id') id: string,
        @Param('highlightId') highlightId: string,
        @Body() body: { note?: string; color?: string },
        @CurrentUser() currentUser: ClerkUserProfile,
    ): Promise<{ highlight: Highlight }> {
        const ua = await this.getUserArticle(currentUser, id);

        const highlights = ua.highlights || [];
        const idx = highlights.findIndex((h) => h.id === highlightId);
        if (idx === -1) throw new NotFoundException('Highlight not found');

        if (body.note !== undefined) highlights[idx].note = body.note;
        if (body.color !== undefined) highlights[idx].color = body.color;

        await this.userArticlesService.updateById(ua.id, { highlights });
        return { highlight: highlights[idx] };
    }

    @Delete(':id/highlights/:highlightId')
    async deleteHighlight(
        @Param('id') id: string,
        @Param('highlightId') highlightId: string,
        @CurrentUser() currentUser: ClerkUserProfile,
    ): Promise<{ success: boolean }> {
        const ua = await this.getUserArticle(currentUser, id);

        const highlights = ua.highlights || [];
        const filtered = highlights.filter((h) => h.id !== highlightId);

        if (filtered.length === highlights.length) {
            throw new NotFoundException('Highlight not found');
        }

        await this.userArticlesService.updateById(ua.id, { highlights: filtered });
        return { success: true };
    }

    private async getUserArticle(currentUser: ClerkUserProfile, articleId: string) {
        const user = await this.usersService.findByClerkId(currentUser.clerkId);
        if (!user?.id) {
            throw new UnauthorizedException('User not found.');
        }
        const ua = await this.userArticlesService.findByUserAndArticle(user.id, articleId);
        if (!ua) throw new NotFoundException('Article not found');
        return ua;
    }
}
