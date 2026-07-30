import { Controller, Get, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ClerkAuthGuard } from '../auth/guards/clerk-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { ClerkUserProfile } from '../auth/interfaces/clerk-user-profile.interface';
import { UsersService } from '../users/users.service';
import { CollectionsService } from './collections.service';
import { Collection } from './entities/collection.entity';

/**
 * Ports lb-laterleaf/src/controllers/user-collection.controller.ts.
 */
@UseGuards(ClerkAuthGuard)
@Controller('users/me')
export class UserCollectionsController {
    constructor(
        private readonly usersService: UsersService,
        private readonly collectionsService: CollectionsService,
    ) { }

    @Get('collections')
    async findMyCollections(@CurrentUser() currentUser: ClerkUserProfile): Promise<Collection[]> {
        const user = await this.usersService.findByClerkId(currentUser.clerkId);
        if (!user?.id) {
            throw new UnauthorizedException('User not found.');
        }
        return this.collectionsService.find({ where: { userId: user.id } });
    }
}
