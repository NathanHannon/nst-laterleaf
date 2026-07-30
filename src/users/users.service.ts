import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
    FindOptionsWhere,
    FindManyOptions,
    Repository,
} from 'typeorm';
import { User } from './entities/user.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';

@Injectable()
export class UsersService {
    constructor(
        @InjectRepository(User)
        private readonly usersRepository: Repository<User>,
    ) { }

    findByClerkId(clerkId: string): Promise<User | null> {
        return this.usersRepository.findOne({ where: { clerkId } });
    }

    findById(id: string): Promise<User | null> {
        return this.usersRepository.findOne({ where: { id } });
    }

    async updateById(id: string, partial: Partial<User>): Promise<void> {
        await this.usersRepository.update({ id }, partial);
    }

    async findByClerkIdOrThrow(clerkId: string): Promise<User> {
        const user = await this.findByClerkId(clerkId);
        if (!user) {
            throw new NotFoundException('User not found');
        }
        return user;
    }

    create(dto: CreateUserDto): Promise<User> {
        const user = this.usersRepository.create(dto);
        return this.usersRepository.save(user);
    }

    save(user: User): Promise<User> {
        return this.usersRepository.save(user);
    }

    count(where?: FindOptionsWhere<User>): Promise<number> {
        return this.usersRepository.count({ where });
    }

    find(options?: FindManyOptions<User>): Promise<User[]> {
        return this.usersRepository.find(options);
    }

    async updateAll(
        partial: Partial<User>,
        where: FindOptionsWhere<User>,
    ): Promise<{ count: number }> {
        const result = await this.usersRepository.update(where, partial);
        return { count: result.affected ?? 0 };
    }

    async updatePreferences(
        clerkId: string,
        dto: UpdatePreferencesDto,
    ): Promise<void> {
        const updateData: Partial<User> = {};
        if (dto.appearance) updateData.preferredAppearance = dto.appearance;
        if (dto.theme) updateData.preferredTheme = dto.theme;

        await this.usersRepository.update({ clerkId }, updateData);
    }

    async demote(clerkId: string): Promise<void> {
        const user = await this.findByClerkId(clerkId);
        if (user) {
            await this.usersRepository.update(
                { id: user.id },
                { isPro: false, subscriptionStatus: 'inactive' },
            );
            console.log(`📉 Dev Tool: Demoted user ${user.id} to free tier`);
        }
    }

    async deleteById(id: string): Promise<void> {
        await this.usersRepository.delete({ id });
    }
}
