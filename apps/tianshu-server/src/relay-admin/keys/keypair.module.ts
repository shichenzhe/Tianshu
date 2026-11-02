import { Module } from '@nestjs/common';
import { KeypairService } from './keypair.service';

/** relay-admin access 签发密钥模块（Task 12）：token 签发消费；公钥导出面
 * （Task 17 运营工作流）与后续密钥轮换扩展在此挂载 */
@Module({
  providers: [KeypairService],
  exports: [KeypairService],
})
export class KeysModule {}
