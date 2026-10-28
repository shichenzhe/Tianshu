import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../guard/jwt-auth.guard';
export const AUTH_KEY_JWT = 'JwtAuth';
export function JwtAuth() {
  return applyDecorators(
    SetMetadata(AUTH_KEY_JWT, true),
    UseGuards(JwtAuthGuard),
  );
}
