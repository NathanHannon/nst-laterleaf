import { IsBoolean, IsIn, IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';
import type { SubscriptionStatus } from '../entities/user.entity';

export class CreateUserDto {
    @IsNotEmpty()
    @IsString()
    clerkId: string;

    @IsOptional()
    @IsNumber()
    basicCreditsUsed?: number;

    @IsOptional()
    @IsNumber()
    proCreditsUsed?: number;

    @IsOptional()
    @IsBoolean()
    isPro?: boolean;

    @IsOptional()
    @IsIn(['inactive', 'active', 'canceled', 'past_due', 'unpaid'])
    subscriptionStatus?: SubscriptionStatus;
}
