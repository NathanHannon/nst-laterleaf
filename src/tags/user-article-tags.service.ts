import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { In, Repository } from 'typeorm';
import { UserArticleTag } from './entities/user-article-tag.entity';

@Injectable()
export class UserArticleTagsService {
    constructor(
        @InjectRepository(UserArticleTag)
        private readonly userArticleTagsRepository: Repository<UserArticleTag>,
    ) { }

    findByUserArticleId(userArticleId: string): Promise<UserArticleTag[]> {
        return this.userArticleTagsRepository.find({ where: { userArticleId } });
    }

    /**
     * Used by RecommendationService to identify which of a user's articles
     * have been explicitly tagged (a strong interest signal).
     */
    findByUserArticleIds(userArticleIds: string[]): Promise<UserArticleTag[]> {
        if (userArticleIds.length === 0) return Promise.resolve([]);
        return this.userArticleTagsRepository.find({ where: { userArticleId: In(userArticleIds) } });
    }

    findLink(userArticleId: string, tagId: string): Promise<UserArticleTag | null> {
        return this.userArticleTagsRepository.findOne({ where: { userArticleId, tagId } });
    }

    create(userArticleId: string, tagId: string): Promise<UserArticleTag> {
        const link = this.userArticleTagsRepository.create({
            id: randomUUID(),
            userArticleId,
            tagId,
        });
        return this.userArticleTagsRepository.save(link);
    }

    async deleteByUserArticleAndTagIds(userArticleId: string, tagIds: string[]): Promise<void> {
        if (tagIds.length === 0) return;
        await this.userArticleTagsRepository.delete({
            userArticleId,
            tagId: In(tagIds),
        });
    }

    /**
     * Bulk-deletes all tag links for the given UserArticle ids. Used by the
     * Clerk `user.deleted` webhook handler's cascade cleanup.
     */
    async deleteByUserArticleIds(userArticleIds: string[]): Promise<void> {
        if (userArticleIds.length === 0) return;
        await this.userArticleTagsRepository.delete({ userArticleId: In(userArticleIds) });
    }
}
