import { Module } from '@nestjs/common';
import { AksModule } from '../aks/aks.module';
import { KeysModule } from '../keys/keypair.module';
import { TokenController } from './token.controller';
import { TokenService } from './token.service';

/** relay-admin token 换发模块（Task 12）：AksModule 供 isAkUsable 凭证
 * 判定，KeysModule 供 Ed25519 签发密钥；RaPrismaService @Global 免 import */
@Module({
  imports: [AksModule, KeysModule],
  controllers: [TokenController],
  providers: [TokenService],
})
export class TokenModule {}
