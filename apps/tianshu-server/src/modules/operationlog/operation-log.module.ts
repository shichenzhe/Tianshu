import { Global, Module } from '@nestjs/common';
import { OperationLogService } from './operation-log.service';
import { OperationLogController } from './operation-log.controller';
import { OperationLogRepository } from './operation-log.repository';

@Global()
@Module({
  controllers: [OperationLogController],
  providers: [OperationLogService, OperationLogRepository],
  exports: [OperationLogService, OperationLogRepository],
})
export class OperationLogModule {}
