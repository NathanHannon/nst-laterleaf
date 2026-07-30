import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BlockedDomain } from './entities/blocked-domain.entity';

/**
 */
@Injectable()
export class BlockedDomainsService {
    constructor(
        @InjectRepository(BlockedDomain)
        private readonly blockedDomainsRepository: Repository<BlockedDomain>,
    ) { }

    /**
     * Check if a domain is blocked
     */
    async isDomainBlocked(domain: string): Promise<{
        isBlocked: boolean;
        reason?: string;
        notes?: string;
    }> {
        const blockedDomain = await this.blockedDomainsRepository.findOne({
            where: { domain: domain.toLowerCase() },
        });

        if (blockedDomain) {
            return {
                isBlocked: true,
                reason: blockedDomain.reason,
                notes: blockedDomain.notes,
            };
        }

        return { isBlocked: false };
    }

    /**
     * Get all blocked domains for caching
     */
    async getAllBlockedDomains(): Promise<string[]> {
        const blockedDomains = await this.blockedDomainsRepository.find({
            select: { domain: true },
        });
        return blockedDomains.map((bd) => bd.domain.toLowerCase());
    }

    create(data: { domain: string; reason: string; notes?: string }): Promise<BlockedDomain> {
        const blockedDomain = this.blockedDomainsRepository.create(data);
        return this.blockedDomainsRepository.save(blockedDomain);
    }

    async deleteByDomain(domain: string): Promise<void> {
        await this.blockedDomainsRepository.delete({ domain: domain.toLowerCase() });
    }
}
