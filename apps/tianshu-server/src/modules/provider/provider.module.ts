import { Module } from '@nestjs/common';
import { PrismaModule } from '../../commons/database/prisma.module';
import { ProviderController } from './provider.controller';
import { ProviderService } from './provider.service';
import { ProviderRepository } from './provider.repository';

@Module({
  imports: [PrismaModule],
  controllers: [ProviderController],
  providers: [ProviderService, ProviderRepository],
})
export class ProviderModule {}
