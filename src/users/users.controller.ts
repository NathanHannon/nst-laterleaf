import {
    Body,
    Controller,
    ForbiddenException,
    Get,
    NotFoundException,
    Patch,
    Post,
    Query,
    UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClerkAuthGuard } from '../auth/guards/clerk-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { ClerkUserProfile } from '../auth/interfaces/clerk-user-profile.interface';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { FindOptionsWhere } from 'typeorm';
import { User } from './entities/user.entity';

const BASIC_CREDITS_LIMIT = -1; // Basic summaries are unlimited
const PRO_CREDITS_LIMIT = 5;

/**
 */
@UseGuards(ClerkAuthGuard)
@Controller('users')
export class UsersController {
    constructor(
        private readonly usersService: UsersService,
        private readonly configService: ConfigService,
    ) { }

    private requireAdmin(currentUser: ClerkUserProfile): void {
        const adminClerkIds = this.configService
            .get<string>('ADMIN_CLERK_IDS')
            ?.split(',');

        if (adminClerkIds?.includes(currentUser.clerkId)) {
            return;
        }

        const role = currentUser.publicMetadata?.role;
        if (role !== 'admin' && role !== 'moderator') {
            throw new ForbiddenException('Admin access required');
        }
    }

    @Get('me')
    async getCurrentUser(@CurrentUser() currentUser: ClerkUserProfile) {
        const user = await this.usersService.findByClerkId(currentUser.clerkId);
        if (!user) {
            throw new NotFoundException('User not found');
        }

        const hasProAccess =
            user.isPro || currentUser.publicMetadata?.role === 'admin';
        const tier = hasProAccess ? 'pro' : 'free';

        const now = new Date();
        const resetDate = new Date(user.creditsResetAt);
        const daysSinceReset = Math.floor(
            (now.getTime() - resetDate.getTime()) / (1000 * 60 * 60 * 24),
        );
        const needsReset = daysSinceReset >= 30;

        const credits = {
            basicCreditsUsed: needsReset ? 0 : user.basicCreditsUsed,
            basicCreditsLimit: BASIC_CREDITS_LIMIT,
            basicCreditsRemaining: BASIC_CREDITS_LIMIT,
            proCreditsUsed: needsReset ? 0 : user.proCreditsUsed,
            proCreditsLimit: PRO_CREDITS_LIMIT,
            proCreditsRemaining: needsReset
                ? PRO_CREDITS_LIMIT
                : Math.max(0, PRO_CREDITS_LIMIT - user.proCreditsUsed),
            resetAt: user.creditsResetAt,
            daysUntilReset: Math.max(0, 30 - daysSinceReset),
            needsReset,
        };

        return { user, hasProAccess, tier, credits };
    }

    @Post()
    async create(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Body() dto: CreateUserDto,
    ) {
        this.requireAdmin(currentUser);
        return this.usersService.create(dto);
    }

    @Get('count')
    async count(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Query('where') where?: string,
    ) {
        this.requireAdmin(currentUser);
        const parsedWhere = where
            ? (JSON.parse(where) as FindOptionsWhere<User>)
            : undefined;
        return { count: await this.usersService.count(parsedWhere) };
    }

    @Get()
    async find(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Query('filter') filter?: string,
    ) {
        this.requireAdmin(currentUser);
        const parsedFilter = filter ? JSON.parse(filter) : undefined;
        return this.usersService.find(parsedFilter);
    }

    @Patch()
    async updateAll(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Body() dto: UpdateUserDto,
        @Query('where') where?: string,
    ) {
        this.requireAdmin(currentUser);
        const parsedWhere = where
            ? (JSON.parse(where) as FindOptionsWhere<User>)
            : {};
        return this.usersService.updateAll(dto, parsedWhere);
    }

    @Patch('me/preferences')
    async updatePreferences(
        @CurrentUser() currentUser: ClerkUserProfile,
        @Body() dto: UpdatePreferencesDto,
    ): Promise<void> {
        await this.usersService.updatePreferences(currentUser.clerkId, dto);
    }

    @Post('me/demote')
    async demoteSelf(@CurrentUser() currentUser: ClerkUserProfile): Promise<void> {
        await this.usersService.demote(currentUser.clerkId);
    }

    @Get('me/status')
    async getMyStatus(@CurrentUser() currentUser: ClerkUserProfile) {
        const user = await this.usersService.findByClerkId(currentUser.clerkId);
        return { isPro: user?.isPro ?? false };
    }
}
