import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * `feed_articles`). Caches articles fetched from a user's subscribed
 * `Feed`. Deduplicated by unique `url`.
 */
@Entity({ name: 'feed_articles' })
export class FeedArticle {
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

    @Column({ name: 'published_at', type: 'timestamptz', default: () => 'now()' })
    publishedAt: Date;

    @Column({ name: 'fetched_at', type: 'timestamptz', default: () => 'now()' })
    fetchedAt?: Date;

    @Column({ name: 'feed_id', type: 'uuid', nullable: true })
    feedId?: string;
}
