import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Mirrors lb-laterleaf/src/models/curated-article.model.ts (table:
 * `curated_articles`). Articles fetched from admin-curated `CuratedFeed`
 * sources, shown on the public "Discover" page.
 */
@Entity({ name: 'curated_articles' })
export class CuratedArticle {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ unique: true })
    url: string;

    @Column()
    title: string;

    @Column({ name: 'content_html', type: 'text', nullable: true })
    contentHtml?: string;

    @Column({ type: 'text', nullable: true })
    description?: string;

    @Column({ nullable: true })
    author?: string;

    @Column({ name: 'image_url', nullable: true })
    imageUrl?: string;

    @Column({ name: 'fetched_at', type: 'timestamptz', default: () => 'now()' })
    fetchedAt?: Date;

    @Column({ name: 'feed_id', nullable: true })
    feedId?: string;
}
