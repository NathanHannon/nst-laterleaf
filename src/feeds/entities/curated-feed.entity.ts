import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * `curated_feeds`). Admin-managed RSS feed sources used to populate the
 * public "Discover" page (`CuratedArticle`).
 *
 * NOTE: `curatedArticles` (hasMany CuratedArticle) relation omitted; joins
 * done manually via `feedId`.
 */
@Entity({ name: 'curated_feeds' })
export class CuratedFeed {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    name: string;

    @Column({ unique: true })
    url: string;

    @Column({ nullable: true })
    category?: string;

    @Column({ name: 'is_active', default: true })
    isActive?: boolean;
}
