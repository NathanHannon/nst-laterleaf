import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { ClerkUserProfile } from '../interfaces/clerk-user-profile.interface';

/**
 * Equivalent to `@inject(SecurityBindings.USER)` in lb-laterleaf.
 * Usage: `getCurrentUser(@CurrentUser() user: ClerkUserProfile)`
 */
export const CurrentUser = createParamDecorator(
    (_data: unknown, ctx: ExecutionContext): ClerkUserProfile => {
        const request = ctx.switchToHttp().getRequest();
        return request.user;
    },
);
