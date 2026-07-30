import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Mirrors lb-laterleaf/src/models/tag.model.ts. `id` is generated in
 * application code (TagsService), not by the database, matching the
 * original model's `defaultFn: 'uuidv4'` (LoopBack-generated, not DB
 * default).
 *
 * NOTE: `embedding` (pgvector `vector(768)`) is mapped as raw `text`
 * (select: false) — population/comparison happens via GenAiService +
 * TagRepository.findSimilar in lb-laterleaf, both deferred to the GenAI
 * services phase.
 */
@Entity({ name: 'tags' })
export class Tag {
    @PrimaryColumn('uuid')
    id: string;

    @Column()
    name: string;

    @Column({ type: 'text', nullable: true, select: false })
    embedding?: string;

    @CreateDateColumn({ name: 'created_at' })
    createdAt?: Date;

    @UpdateDateColumn({ name: 'updated_at' })
    updatedAt?: Date;
}
