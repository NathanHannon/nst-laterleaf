import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

export interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
    timestamp?: string;
}

export interface Highlight {
    id: string;
    text: string;
    note?: string;
    color?: string;
    createdAt?: string;
}

/**
 * Mirrors lb-laterleaf/src/models/user-article.model.ts. This is the
 * critical junction model — most per-user article state (status,
 * bookmarks, summaries, chat, audio) lives here, not on Article.
 *
 * NOTE: `tags` / `userArticleTags` relations are omitted until the Tags
 * module is ported. `userId` / `articleId` are kept as plain FK columns
 * (no TypeORM @ManyToOne) to avoid circular module imports between
 * UsersModule and ArticlesModule; joins are done manually in services.
 */
@Entity({ name: 'user_articles' })
export class UserArticle {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'has_content', default: false })
    hasContent?: boolean;

    @Column({ type: 'text', nullable: true })
    summary?: string;

    @Column({ name: 'summary_language', default: 'en' })
    summaryLanguage?: string;

    @Column({ name: 'summary_status', default: 'idle' })
    summaryStatus?: string;

    @Column({ name: 'chat_history', type: 'jsonb', default: () => "'[]'" })
    chatHistory?: ChatMessage[];

    @Column({ name: 'chat_interaction_id', nullable: true })
    chatInteractionId?: string;

    @Column({ name: 'podcast_script', type: 'jsonb', nullable: true })
    podcastScript?: object;

    @Column({ name: 'audio_location', nullable: true })
    audioLocation?: string;

    @Column({ name: 'audio_status', default: 'idle' })
    audioStatus?: string;

    @Column({ name: 'audio_language', nullable: true })
    audioLanguage?: string;

    @Column({ default: 'unread' })
    status: string;

    @Column({ name: 'is_bookmarked', default: false })
    isBookmarked: boolean;

    @Column({ name: 'is_liked', default: false })
    isLiked: boolean;

    @Column({ name: 'is_archived', default: false })
    isArchived: boolean;

    @Column({ name: 'progress_percentage', type: 'int', default: 0 })
    progressPercentage?: number;

    @Column({ name: 'last_read_at', type: 'timestamp', nullable: true })
    lastReadAt?: Date;

    @Column({ type: 'jsonb', default: () => "'[]'" })
    highlights?: Highlight[];

    @Column({ name: 'suggested_tags', type: 'jsonb', default: () => "'[]'" })
    suggestedTags?: string[];

    @Column({ name: 'updated_at', type: 'timestamp', nullable: true })
    updatedAt: Date;

    @Column({ name: 'original_url', nullable: true })
    originalUrl?: string;

    @Column({ name: 'created_at', type: 'timestamp', nullable: true })
    createdAt: Date;

    @Column({ name: 'user_id' })
    userId: string;

    @Column({ name: 'article_id', nullable: true })
    articleId?: string;
}
