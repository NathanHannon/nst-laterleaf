import { Body, Controller, Delete, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { ClerkAuthGuard } from '../auth/guards/clerk-auth.guard';
import { TagsService } from './tags.service';
import { UserArticleTagsService } from './user-article-tags.service';
import { Tag } from './entities/tag.entity';

/**
 * Ports lb-laterleaf/src/controllers/user-article-tag.controller.ts
 * (GET/PATCH/DELETE only — the original POST endpoint was already moved to
 * TagController.addTagToUserArticle in lb-laterleaf, which is deferred to
 * the GenAI services phase since it calls GenAiService.generateEmbeddings).
 *
 * NOTE: matches the ORIGINAL controller's behavior of NOT verifying that
 * the `:id` UserArticle actually belongs to the requesting user — only
 * `@authenticate('clerk')`/`ClerkAuthGuard` gates access. Ported as-is for
 * parity; worth a security review later.
 */
@UseGuards(ClerkAuthGuard)
@Controller('user-articles')
export class UserArticleTagsController {
    constructor(
        private readonly userArticleTagsService: UserArticleTagsService,
        private readonly tagsService: TagsService,
    ) { }

    @Get(':id/tags')
    async find(@Param('id') id: string): Promise<Tag[]> {
        const links = await this.userArticleTagsService.findByUserArticleId(id);
        return this.tagsService.findByIds(links.map((link) => link.tagId));
    }

    @Patch(':id/tags')
    async patch(
        @Param('id') id: string,
        @Body() tag: Partial<Tag>,
        @Query('where') where?: string,
    ): Promise<{ count: number }> {
        const links = await this.userArticleTagsService.findByUserArticleId(id);
        const linkedTagIds = links.map((link) => link.tagId);
        const targetIds = filterIds(linkedTagIds, where);
        const count = await this.tagsService.updateByIds(targetIds, tag);
        return { count };
    }

    /**
     * FIXED: previously mirrored lb-laterleaf's hasMany-through
     * `.tags(id).delete(where)`, which deleted the actual (global, shared)
     * Tag rows matching `where` — not just the link for this user/article.
     * Since Tags are a shared pool (looked up by name across all users in
     * TagController.addTagToUserArticle), that deleted a tag other users
     * still referenced. Both lb-laterleaf (switched to `.unlink()`) and this
     * controller now only remove the UserArticleTag join row(s), leaving the
     * shared Tag row(s) intact.
     */
    @Delete(':id/tags')
    async delete(
        @Param('id') id: string,
        @Query('where') where?: string,
    ): Promise<{ count: number }> {
        const links = await this.userArticleTagsService.findByUserArticleId(id);
        const linkedTagIds = links.map((link) => link.tagId);
        const targetIds = filterIds(linkedTagIds, where);

        await this.userArticleTagsService.deleteByUserArticleAndTagIds(id, targetIds);
        return { count: targetIds.length };
    }
}

/**
 * Narrow support for the `where` shapes actually sent by the frontend
 * (e.g. `{"id":"<tagId>"}`), scoped down to the tag ids already linked to
 * this UserArticle.
 */
function filterIds(linkedIds: string[], where?: string): string[] {
    if (!where) return linkedIds;
    const parsed = JSON.parse(where) as { id?: string };
    if (!parsed.id) return linkedIds;
    return linkedIds.includes(parsed.id) ? [parsed.id] : [];
}
