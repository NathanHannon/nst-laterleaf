import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Mirrors lb-laterleaf/src/models/article-chunks.model.ts.
 *
 * NOTE: `chunk_embedding` is a pgvector `vector(768)` column. TypeORM has no
 * native pgvector type, so it's mapped as raw `text` (select: false) and
 * manipulated via raw SQL, matching Article.embedding's pattern.
 * NOTE: `articleId` is kept as a plain FK column (no @ManyToOne) to match
 * the rest of the Articles module's relation-free convention.
 */
@Entity({ name: 'article_chunks' })
export class ArticleChunks {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'chunk_text', type: 'text', nullable: true })
    chunkText?: string;

    @Column({ name: 'chunk_embedding', type: 'text', nullable: true, select: false })
    chunkEmbedding?: string;

    @Column({ name: 'chunk_index', type: 'int', nullable: true })
    chunkIndex?: number;

    @Column({ name: 'article_id' })
    articleId: string;
}
