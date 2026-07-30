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
