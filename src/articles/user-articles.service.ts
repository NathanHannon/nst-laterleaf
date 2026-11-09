import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, FindManyOptions, In, IsNull, Not, Repository } from 'typeorm';
import { UserArticle } from './entities/user-article.entity';

@Injectable()
export class UserArticlesService {
    constructor(
        @InjectRepository(UserArticle)
        private readonly userArticlesRepository: Repository<UserArticle>,
    ) { }

    findById(id: string): Promise<UserArticle | null> {
        return this.userArticlesRepository.findOne({ where: { id } });
    }

    findByUserAndArticle(userId: string, articleId: string): Promise<UserArticle | null> {
        return this.userArticlesRepository.findOne({ where: { userId, articleId } });
    }

    findByUserAndOriginalUrl(userId: string, originalUrl: string): Promise<UserArticle | null> {
        return this.userArticlesRepository.findOne({ where: { userId, originalUrl } });
    }

    /**
     * Finds all UserArticle entries that have an `originalUrl` but no
     * `articleId` (i.e. extraction previously failed). Used by
     * `ArticlesController.upgradeUrlOnlyEntries` to retroactively link these
     * entries once the same URL is successfully extracted/imported by
     * another user.
     */
    findUrlOnlyEntries(): Promise<UserArticle[]> {
        return this.userArticlesRepository.find({
            where: { articleId: IsNull(), originalUrl: Not(IsNull()) },
        });
    }

    findAllForUser(userId: string, options?: FindManyOptions<UserArticle>): Promise<UserArticle[]> {
        return this.userArticlesRepository.find({ where: { userId }, ...options });
    }

    create(data: Partial<UserArticle>): Promise<UserArticle> {
        const userArticle = this.userArticlesRepository.create(data);
        return this.userArticlesRepository.save(userArticle);
    }

    async updateById(id: string, partial: Partial<UserArticle>): Promise<void> {
        await this.userArticlesRepository.update({ id }, partial);
    }

    async savePastedEmbedding(id: string, userId: string, embedding: number[]): Promise<void> {
        const embeddingString = `[${embedding.join(',')}]`;
        await this.userArticlesRepository.query(
            `UPDATE public.user_articles
             SET pasted_embedding = $1::vector
             WHERE id = $2 AND user_id = $3 AND pasted_content IS NOT NULL`,
            [embeddingString, id, userId],
        );
    }

    async semanticSearchPasted(embedding: number[], userId: string, limit = 10): Promise<Array<{
        userArticleId: string;
        title: string;
        content: string;
        excerpt: string;
        siteName: string;
        summary?: string;
        audioLocation?: string | null;
        createdAt: Date;
        updatedAt: Date;
        isBookmarked: boolean;
        isLiked: boolean;
        isArchived: boolean;
        distance: number;
    }>> {
        const embeddingString = `[${embedding.join(',')}]`;
        return this.userArticlesRepository.query(
            `SELECT id AS "userArticleId",
                    COALESCE(
                        NULLIF(BTRIM(pasted_title), ''),
                        LEFT(NULLIF(BTRIM(SPLIT_PART(pasted_content, E'\\n', 1)), ''), 120),
                        'Pasted text'
                    ) AS title,
                    pasted_content AS content,
                    LEFT(REGEXP_REPLACE(pasted_content, '\\s+', ' ', 'g'), 240) AS excerpt,
                    'Pasted text' AS "siteName",
                    summary, audio_location AS "audioLocation",
                    created_at AS "createdAt", updated_at AS "updatedAt",
                    is_bookmarked AS "isBookmarked", is_liked AS "isLiked",
                    is_archived AS "isArchived",
                    (pasted_embedding <=> $2::vector) AS distance
             FROM public.user_articles
             WHERE user_id = $1
               AND pasted_content IS NOT NULL
               AND pasted_embedding IS NOT NULL
             ORDER BY pasted_embedding <=> $2::vector
             LIMIT $3`,
            [userId, embeddingString, limit],
        );
    }

    async keywordSearchPasted(query: string, userId: string, limit = 20): Promise<Array<{
        userArticleId: string;
        title: string;
        content: string;
        excerpt: string;
        siteName: string;
        summary?: string;
        audioLocation?: string | null;
        createdAt: Date;
        updatedAt: Date;
        isBookmarked: boolean;
        isLiked: boolean;
        isArchived: boolean;
    }>> {
        const searchTerm = `%${query}%`;
        return this.userArticlesRepository.query(
            `SELECT id AS "userArticleId",
                    COALESCE(
                        NULLIF(BTRIM(pasted_title), ''),
                        LEFT(NULLIF(BTRIM(SPLIT_PART(pasted_content, E'\\n', 1)), ''), 120),
                        'Pasted text'
                    ) AS title,
                    pasted_content AS content,
                    LEFT(REGEXP_REPLACE(pasted_content, '\\s+', ' ', 'g'), 240) AS excerpt,
                    'Pasted text' AS "siteName", summary,
                    audio_location AS "audioLocation",
                    created_at AS "createdAt", updated_at AS "updatedAt",
                    is_bookmarked AS "isBookmarked", is_liked AS "isLiked",
                    is_archived AS "isArchived"
             FROM public.user_articles
             WHERE user_id = $1
               AND pasted_content IS NOT NULL
               AND (pasted_title ILIKE $2 OR pasted_content ILIKE $2)
             ORDER BY created_at DESC
             LIMIT $3`,
            [userId, searchTerm, limit],
        );
    }

    save(entity: UserArticle): Promise<UserArticle> {
        return this.userArticlesRepository.save(entity);
    }

    async delete(entity: UserArticle): Promise<void> {
        await this.userArticlesRepository.remove(entity);
    }

    /**
     * Bulk-deletes all UserArticle rows for the given user. Used by the
     * Clerk `user.deleted` webhook handler's cascade cleanup.
     */
    async deleteAllForUser(userId: string): Promise<number> {
        const result = await this.userArticlesRepository.delete({ userId });
        return result.affected ?? 0;
    }

    /**
     * Finds UserArticle rows created within `[start, end]` for the given
     * user. Used by StatsController's "wrapped" year-in-review stats.
     */
    findSavedInRange(userId: string, start: Date, end: Date): Promise<UserArticle[]> {
        return this.userArticlesRepository.find({
            where: { userId, createdAt: Between(start, end) },
        });
    }

    /**
     * Finds UserArticle rows with status 'read'/'archived' whose
     * `lastReadAt` falls within `[start, end]` for the given user. Used by
     * StatsController's "wrapped" year-in-review stats.
     */
    findReadInRange(userId: string, start: Date, end: Date): Promise<UserArticle[]> {
        return this.userArticlesRepository.find({
            where: { userId, status: In(['read', 'archived']), lastReadAt: Between(start, end) },
        });
    }
}
