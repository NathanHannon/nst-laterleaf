import { Module } from '@nestjs/common';
import { ImportController } from './import.controller';
import { UsersModule } from '../users/users.module';

@Module({
    imports: [UsersModule],
    controllers: [ImportController],
})
export class ImportModule { }
