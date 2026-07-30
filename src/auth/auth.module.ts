import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { ClerkStrategy } from './strategies/clerk.strategy';

@Module({
    imports: [PassportModule],
    providers: [ClerkStrategy],
    exports: [PassportModule],
})
export class AuthModule { }
