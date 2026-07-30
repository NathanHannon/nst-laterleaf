import {
    Column,
    CreateDateColumn,
    Entity,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';

/**
 * Mirrors lb-laterleaf/src/models/article.model.ts.
 *
 * NOTE: `articleChunks` (hasMany ArticleChunks) and `users` (hasMany-through
 * UserArticle) relations are intentionally omitted. They'll be added once
 * the ArticleChunks/Tags modules are ported. Joins against `user_articles`
 * are done via UserArticlesService in the meantime.
 *
 * NOTE: `embedding` is a pgvector `vector(768)` column. TypeORM has no
 * native pgvector type, so it's mapped as raw `text` (select: false, so it
 * isn't returned by default queries) and manipulated via raw SQL in
 * ArticlesService, matching how lb-laterleaf's ArticleRepository does it.
 */
@Entity({ name: 'articles' })
export class Article {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    url: string;

    @Column({ nullable: true })
    title?: string;

    @Column({ type: 'text', nullable: true })
    content?: string;

    @Column({ name: 'content_html', type: 'text', nullable: true })
    contentHtml?: string;

    @Column({ type: 'text', nullable: true })
    excerpt?: string;

    @Column({ type: 'jsonb', nullable: true })
    translations?: Record<string, string>;

    @Column({ nullable: true })
    author?: string;

    @Column({ name: 'image_url', nullable: true })
    imageUrl?: string;

    @Column({ name: 'site_name', nullable: true })
    siteName?: string;

    @Column({ name: 'site_icon', nullable: true })
    siteIcon?: string;

    @Column({ name: 'og_image', nullable: true })
    ogImage?: string;

    @Column({ name: 'og_description', nullable: true })
    ogDescription?: string;

    @Column({ name: 'theme_color', nullable: true })
    themeColor?: string;

    @Column({ name: 'og_type', nullable: true })
    ogType?: string;

    @Column({ name: 'metadata_scraped_at', type: 'timestamp', nullable: true })
    metadataScrapedAt?: Date;

    @Column({ name: 'publish_date', type: 'timestamp', nullable: true })
    publishDate?: Date;

    @CreateDateColumn({ name: 'created_at' })
    createdAt: Date;

    @UpdateDateColumn({ name: 'updated_at' })
    updatedAt: Date;

    @Column({ type: 'text', nullable: true, select: false })
    embedding?: string;

    @Column({
        name: 'is_eligible_for_recommendation',
        nullable: true,
        select: false,
    })
    isEligibleForRecommendation?: boolean;

    @Column({ name: 'save_count', type: 'int', default: 0 })
    saveCount?: number;

    @Column({ name: 'bookmark_count', type: 'int', default: 0 })
    bookmarkCount?: number;

    @Column({ name: 'reading_time', type: 'int', default: 0 })
    readingTime?: number;

    @Column({ name: 'narration_location', nullable: true })
    narrationLocation?: string;

    @Column({ name: 'narration_status', default: 'idle' })
    narrationStatus?: string;
}
