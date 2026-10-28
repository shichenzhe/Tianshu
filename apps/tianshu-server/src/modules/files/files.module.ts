import { Module } from '@nestjs/common';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';

/** 文件面模块（FA-T1）：PrismaModule 全局供给（starter 装配） */
@Module({
  controllers: [FilesController],
  providers: [FilesService],
})
export class FilesModule {}
