import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * Mirrors lb-laterleaf/src/models/blocked-domain.model.ts (table:
 * blocked_domains). `reason` is a free-form union in LoopBack
 * ('spam' | 'malicious' | 'inappropriate' | 'scam' | 'phishing') — TypeORM
 * has no native union-column validation, so it's stored as `varchar` here;
 * validity is enforced at the DTO/service layer.
 */
@Entity({ name: 'blocked_domains' })
export class BlockedDomain {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    domain: string;

    /** One of: 'spam' | 'malicious' | 'inappropriate' | 'scam' | 'phishing' */
    @Column()
    reason: string;

    @Column({ type: 'varchar', nullable: true })
    notes?: string;

    @CreateDateColumn({ name: 'created_at' })
    createdAt?: Date;

    @UpdateDateColumn({ name: 'updated_at' })
    updatedAt?: Date;
}
