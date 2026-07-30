import { Controller, Get, UseGuards } from '@nestjs/common';
import { ClerkAuthGuard } from '../auth/guards/clerk-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { ClerkUserProfile } from '../auth/interfaces/clerk-user-profile.interface';
import { UsersService } from '../users/users.service';
import { GenAiService } from './gen-ai.service';

/**
 * Ports lb-laterleaf/src/controllers/gen-ai.controller.ts.
 */
@UseGuards(ClerkAuthGuard)
@Controller('ai')
export class GenAiController {
    constructor(
        private readonly genAiService: GenAiService,
        private readonly usersService: UsersService,
    ) { }

    @Get('tts-voices')
    async getTtsVoices(@CurrentUser() currentUser: ClerkUserProfile): Promise<object[]> {
        const dbUser = await this.usersService.findByClerkId(currentUser.clerkId);
        const isProUser = dbUser?.isPro ?? false;

        return this.genAiService.getTTSVoices(isProUser);
    }
}
