import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Mirrors lb-laterleaf/src/models/article-collection.model.ts — the pure
 * junction table between Collection and Article.
 */
@Entity({ name: 'article_collections' })
export class ArticleCollection {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'added_at', type: 'timestamp', nullable: true })
    addedAt: Date;

    @Column({ name: 'collection_id', nullable: true })
    collectionId?: string;

    @Column({ name: 'article_id', nullable: true })
    articleId?: string;
}
