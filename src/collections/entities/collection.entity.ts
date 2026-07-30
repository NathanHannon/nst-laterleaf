import {
    Column,
    CreateDateColumn,
    Entity,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';

/**
 * Mirrors lb-laterleaf/src/models/collection.model.ts.
 * `userId` kept as a plain FK column (no TypeORM relation) to avoid
 * circular imports with UsersModule, matching the Article/UserArticle
 * pattern established in phase 2.
 */
@Entity({ name: 'collections' })
export class Collection {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    name: string;

    @Column({ type: 'text', nullable: true })
    description?: string;

    @Column({ length: 8, nullable: true })
    emoji?: string;

    @CreateDateColumn({ name: 'created_at' })
    createdAt?: Date;

    @UpdateDateColumn({ name: 'updated_at' })
    updatedAt?: Date;

    @Column({ name: 'user_id' })
    userId: string;
}
