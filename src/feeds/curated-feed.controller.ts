import {
    Body,
    Controller,
    Delete,
    ForbiddenException,
    Get,
    Param,
    Patch,
    Post,
    Query,
    UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClerkAuthGuard } from '../auth/guards/clerk-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { ClerkUserProfile } from '../auth/interfaces/clerk-user-profile.interface';
import { CuratedFeedsService } from './curated-feeds.service';
import { CuratedFeed } from './entities/curated-feed.entity';

/**
 * Admin-only CRUD for managing the RSS feed sources used to populate the
 * public Discover page.
 *
 * NOTE: the original LoopBack controller also exposed `GET /count`,
 * `PATCH /` (bulk updateAll) and `PUT /:id` (full replace). These are
 * LoopBack CRUD-scaffolding idioms with no frontend consumer (verified —
 * no references in rct-laterleaf) and are not reproduced here; the
 * create/find/findById/updateById/deleteById endpoints below cover every
 * actual admin operation.
 */
@UseGuards(ClerkAuthGuard)
@Controller('curated-feeds')
export class CuratedFeedController {
    constructor(
        private readonly curatedFeedsService: CuratedFeedsService,
        private readonly configService: ConfigService,
    ) { }

    private requireAdmin(currentUser: ClerkUserProfile): void {
        const adminClerkIds = this.configService.get<string>('ADMIN_CLERK_IDS')?.split(',');
        if (adminClerkIds?.includes(currentUser.clerkId)) {
            return;
        }

        const role = currentUser.publicMetadata?.role;
        if (role !== 'admin' && role !== 'moderator') {
            throw new ForbiddenException('Admin access required');
        }
    }

    @Post()
    async create(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Body() body: Omit<CuratedFeed, 'id'>,
    ): Promise<CuratedFeed> {
        this.requireAdmin(currentUser);
        return this.curatedFeedsService.create(body);
    }

    @Get()
    async find(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Query('isActive') isActive?: string,
    ): Promise<CuratedFeed[]> {
        this.requireAdmin(currentUser);
        if (isActive === undefined) {
            return this.curatedFeedsService.find();
        }
        return this.curatedFeedsService.find({ isActive: isActive === 'true' });
    }

    @Get(':id')
    async findById(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Param('id') id: string,
    ): Promise<CuratedFeed> {
        this.requireAdmin(currentUser);
        return this.curatedFeedsService.findById(id);
    }

    @Patch(':id')
    async updateById(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Param('id') id: string,
        @Body() body: Partial<CuratedFeed>,
    ): Promise<void> {
        this.requireAdmin(currentUser);
        await this.curatedFeedsService.updateById(id, body);
    }

    @Delete(':id')
    async deleteById(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Param('id') id: string,
    ): Promise<void> {
        this.requireAdmin(currentUser);
        await this.curatedFeedsService.deleteById(id);
    }
}
