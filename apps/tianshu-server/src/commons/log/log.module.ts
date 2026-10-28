import { Global, Module } from '@nestjs/common';
import { LoggerFactory } from './logger-factory';
import { ClsModule } from 'nestjs-cls';

@Global()
@Module({
  imports: [ClsModule],
  providers: [LoggerFactory],
  exports: [LoggerFactory],
})
export class LogModule {}
