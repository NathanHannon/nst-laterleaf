import {
    Column,
    CreateDateColumn,
    Entity,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';

export type SubscriptionStatus =
    | 'inactive'
    | 'active'
    | 'canceled'
    | 'past_due'
    | 'unpaid';

/**
 *
 * NOTE: `collections` / `articles` relations are intentionally omitted here.
 * Access patterns use explicit FK columns and service-level joins.
 */
@Entity({ name: 'users' })
export class User {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'clerk_id' })
    clerkId: string;

    @Column({ name: 'basic_credits_used', type: 'int', default: 0 })
    basicCreditsUsed: number;

    @Column({ name: 'pro_credits_used', type: 'int', default: 0 })
    proCreditsUsed: number;

    @Column({ name: 'credits_reset_at', type: 'timestamp' })
    creditsResetAt: Date;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;

    @UpdateDateColumn({ name: 'updated_at' })
    updatedAt: Date;

    @Column({ name: 'is_pro', default: false })
    isPro: boolean;

    @Column({ name: 'subscription_status', default: 'inactive' })
    subscriptionStatus: SubscriptionStatus;

    @Column({ name: 'subscription_expiration', type: 'timestamp', nullable: true })
    subscriptionExpiration?: Date;

    @Column({ name: 'weekly_digest_enabled', default: false })
    weeklyDigestEnabled?: boolean;

    @Column({ name: 'digest_day', default: 'sunday' })
    digestDay?: string;

    @Column({ name: 'dismissed_article_ids', type: 'jsonb', default: () => "'[]'" })
    dismissedArticleIds?: string[];

    @Column({ name: 'preferred_appearance', default: 'system' })
    preferredAppearance?: string;

    @Column({ name: 'preferred_theme', default: 'default' })
    preferredTheme?: string;
}
