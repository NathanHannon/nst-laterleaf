import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserFeed } from './entities/user-feed.entity';

/**
 * between a `User` and a `Feed` (a subscription).
 */
@Injectable()
export class UserFeedsService {
    constructor(
        @InjectRepository(UserFeed)
        private readonly userFeedsRepository: Repository<UserFeed>,
    ) { }

    findAllForUser(userId: string): Promise<UserFeed[]> {
        return this.userFeedsRepository.find({ where: { userId } });
    }

    findById(id: string): Promise<UserFeed | null> {
        return this.userFeedsRepository.findOne({ where: { id } });
    }

    findByUserAndFeed(userId: string, feedId: string): Promise<UserFeed | null> {
        return this.userFeedsRepository.findOne({ where: { userId, feedId } });
    }

    create(data: Partial<UserFeed>): Promise<UserFeed> {
        const userFeed = this.userFeedsRepository.create(data);
        return this.userFeedsRepository.save(userFeed);
    }

    async deleteById(id: string): Promise<void> {
        await this.userFeedsRepository.delete({ id });
    }
}
