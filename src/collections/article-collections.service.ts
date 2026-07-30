import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ArticleCollection } from './entities/article-collection.entity';

@Injectable()
export class ArticleCollectionsService {
    constructor(
        @InjectRepository(ArticleCollection)
        private readonly articleCollectionsRepository: Repository<ArticleCollection>,
    ) { }

    findByCollectionId(collectionId: string): Promise<ArticleCollection[]> {
        return this.articleCollectionsRepository.find({ where: { collectionId } });
    }

    findByArticleId(articleId: string): Promise<ArticleCollection[]> {
        return this.articleCollectionsRepository.find({ where: { articleId } });
    }

    findByCollectionIds(collectionIds: string[]): Promise<ArticleCollection[]> {
        if (collectionIds.length === 0) return Promise.resolve([]);
        return this.articleCollectionsRepository.find({
            where: { collectionId: In(collectionIds) },
        });
    }

    /**
     * Returns, per collection, only the `limitPerCollection` most-recently
     * added article links (mirrors the `scope: {limit: 10}` used in
     * lb-laterleaf's `CollectionSuggestionController.suggestForArticle` to
     * bound the cost of computing a collection's "vibe" embedding).
     * Simplification: since a single user's collections are small, this
     * fetches everything and slices in memory rather than a per-group SQL
     * window function.
     */
    async findRecentByCollectionIds(
        collectionIds: string[],
        limitPerCollection = 10,
    ): Promise<ArticleCollection[]> {
        if (collectionIds.length === 0) return [];

        const all = await this.articleCollectionsRepository.find({
            where: { collectionId: In(collectionIds) },
            order: { addedAt: 'DESC' },
        });

        const byCollection = new Map<string, ArticleCollection[]>();
        for (const link of all) {
            if (!link.collectionId) continue;
            const group = byCollection.get(link.collectionId) ?? [];
            if (group.length < limitPerCollection) {
                group.push(link);
                byCollection.set(link.collectionId, group);
            }
        }

        return Array.from(byCollection.values()).flat();
    }

    findLink(collectionId: string, articleId: string): Promise<ArticleCollection | null> {
        return this.articleCollectionsRepository.findOne({
            where: { collectionId, articleId },
        });
    }

    create(data: Partial<ArticleCollection>): Promise<ArticleCollection> {
        const link = this.articleCollectionsRepository.create(data);
        return this.articleCollectionsRepository.save(link);
    }

    async deleteById(id: string): Promise<void> {
        await this.articleCollectionsRepository.delete({ id });
    }

    /**
     * Bulk-deletes all article-collection links for the given collection
     * ids. Used by the Clerk `user.deleted` webhook handler's cascade
     * cleanup.
     */
    async deleteByCollectionIds(collectionIds: string[]): Promise<void> {
        if (collectionIds.length === 0) return;
        await this.articleCollectionsRepository.delete({ collectionId: In(collectionIds) });
    }
}
