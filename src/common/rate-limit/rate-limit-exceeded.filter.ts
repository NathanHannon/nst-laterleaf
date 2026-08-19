import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { RateLimitExceededException } from './rate-limit-exceeded.exception';

@Catch(RateLimitExceededException)
export class RateLimitExceededFilter implements ExceptionFilter<RateLimitExceededException> {
    catch(exception: RateLimitExceededException, host: ArgumentsHost): void {
        const response = host.switchToHttp().getResponse<Response>();
        const status = exception.getStatus();

        response
            .status(status)
            .setHeader('Retry-After', String(Math.max(1, exception.retryAfterSeconds)))
            .json({
                statusCode: status,
                message: exception.message,
                error: 'Too Many Requests',
                retryAfter: exception.retryAfterSeconds,
            });
    }
}
