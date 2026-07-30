import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Mirrors lb-laterleaf/src/models/user-feed.model.ts (table: `user_feed`).
 * Junction between a `User` and a `Feed` — a user's subscription to a
 * particular RSS feed.
 *
 * NOTE: plain FK columns (`userId`, `feedId`), no `@ManyToOne` relations,
 * matching the established convention to avoid cross-module circular
 * imports (UsersModule <-> FeedsModule).
 */
@Entity({ name: 'user_feed' })
export class UserFeed {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'user_id', type: 'uuid' })
    userId: string;

    @Column({ name: 'feed_id', type: 'uuid' })
    feedId: string;

    @Column({ name: 'title_override', type: 'text', nullable: true })
    titleOverride?: string;

    @Column({ name: 'is_muted', default: false })
    isMuted?: boolean;

    @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
    createdAt?: Date;

    @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
    updatedAt?: Date;
}
