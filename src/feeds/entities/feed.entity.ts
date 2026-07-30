import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * a user-subscribed RSS feed (as opposed to `CuratedFeed`, which is
 * admin-curated for the Discover page).
 *
 * NOTE: `userFeeds` (hasMany UserFeed) relation is intentionally omitted;
 * joins are done manually in services.
 */
@Entity({ name: 'feed' })
export class Feed {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'text' })
    url: string;

    @Column({ name: 'site_url', type: 'text', nullable: true })
    siteUrl?: string;

    @Column({ type: 'text' })
    title: string;

    @Column({ type: 'text', nullable: true })
    description?: string;

    @Column({ name: 'image_url', type: 'text', nullable: true })
    imageUrl?: string;

    @Column({ name: 'last_fetched_at', type: 'timestamptz', nullable: true })
    lastFetchedAt?: Date;

    @Column({ name: 'last_error', type: 'text', nullable: true })
    lastError?: string;

    @Column({ name: 'error_count', type: 'int', default: 0 })
    errorCount?: number;

    @Column({ name: 'is_active', default: true })
    isActive?: boolean;

    @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
    createdAt?: Date;

    @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
    updatedAt?: Date;
}
