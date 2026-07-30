import { Injectable, ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Equivalent to `@authenticate('clerk')` in lb-laterleaf. Apply with
 * `@UseGuards(ClerkAuthGuard)` at the controller or route-handler level.
 */
@Injectable()
export class ClerkAuthGuard extends AuthGuard('clerk') {
    canActivate(context: ExecutionContext) {
        return super.canActivate(context);
    }
}
