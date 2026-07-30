import {
    Body,
    Controller,
    Delete,
    ForbiddenException,
    Get,
    Param,
    Patch,
    Post,
    Put,
    Query,
    UnauthorizedException,
    UseGuards,
} from '@nestjs/common';
import { FindOptionsWhere } from 'typeorm';
import { ClerkAuthGuard } from '../auth/guards/clerk-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { ClerkUserProfile } from '../auth/interfaces/clerk-user-profile.interface';
import { UsersService } from '../users/users.service';
import { CollectionsService } from './collections.service';
import { Collection } from './entities/collection.entity';

/**
 */
@UseGuards(ClerkAuthGuard)
@Controller('collections')
export class CollectionsController {
    constructor(
        private readonly collectionsService: CollectionsService,
        private readonly usersService: UsersService,
    ) { }

    private async getUserId(currentUser: ClerkUserProfile): Promise<string> {
        const user = await this.usersService.findByClerkId(currentUser.clerkId);
        if (!user?.id) {
            throw new UnauthorizedException('USER_NOT_FOUND');
        }
        return user.id;
    }

    private async getOwnedCollectionOrThrow(id: string, userId: string): Promise<Collection> {
        const collection = await this.collectionsService.findById(id);
        if (!collection) {
            throw new ForbiddenException('ACCESS_DENIED');
        }
        if (collection.userId !== userId) {
            throw new ForbiddenException('ACCESS_DENIED');
        }
        return collection;
    }

    @Post()
    async create(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Body() collection: Partial<Collection>,
    ): Promise<Collection> {
        const userId = await this.getUserId(currentUser);
        return this.collectionsService.create({ ...collection, userId });
    }

    @Get('count')
    async count(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Query('where') where?: string,
    ): Promise<{ count: number }> {
        const userId = await this.getUserId(currentUser);
        const parsedWhere = where ? JSON.parse(where) : {};
        return {
            count: await this.collectionsService.count({ ...parsedWhere, userId }),
        };
    }

    @Get()
    async find(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Query('filter') filter?: string,
    ): Promise<Collection[]> {
        const userId = await this.getUserId(currentUser);
        const parsedFilter = filter ? JSON.parse(filter) : {};
        return this.collectionsService.find({
            ...parsedFilter,
            where: { ...parsedFilter?.where, userId },
        });
    }

    @Patch()
    async updateAll(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Body() collection: Partial<Collection>,
        @Query('where') where?: string,
    ): Promise<{ count: number }> {
        const userId = await this.getUserId(currentUser);
        const parsedWhere = where ? (JSON.parse(where) as FindOptionsWhere<Collection>) : {};
        return this.collectionsService.updateAll(collection, { ...parsedWhere, userId });
    }

    @Get(':id')
    async findById(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Param('id') id: string,
    ): Promise<Collection> {
        const userId = await this.getUserId(currentUser);
        return this.getOwnedCollectionOrThrow(id, userId);
    }

    @Patch(':id')
    async updateById(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Param('id') id: string,
        @Body() collection: Partial<Collection>,
    ): Promise<void> {
        const userId = await this.getUserId(currentUser);
        await this.getOwnedCollectionOrThrow(id, userId);
        await this.collectionsService.updateById(id, collection);
    }

    @Put(':id')
    async replaceById(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Param('id') id: string,
        @Body() collection: Partial<Collection>,
    ): Promise<void> {
        const userId = await this.getUserId(currentUser);
        await this.getOwnedCollectionOrThrow(id, userId);
        await this.collectionsService.updateById(id, { ...collection, userId });
    }

    @Delete(':id')
    async deleteById(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Param('id') id: string,
    ): Promise<void> {
        const userId = await this.getUserId(currentUser);
        await this.getOwnedCollectionOrThrow(id, userId);
        await this.collectionsService.deleteById(id);
    }
}
