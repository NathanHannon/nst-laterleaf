import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * 429 carrying the retry delay so RateLimitExceededFilter can emit Retry-After.
 */
export class RateLimitExceededException extends HttpException {
    constructor(
        message: string,
        readonly retryAfterSeconds: number,
    ) {
        super(message, HttpStatus.TOO_MANY_REQUESTS);
    }
}
