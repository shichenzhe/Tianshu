import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../guard/jwt-auth.guard';
export const AUTH_KEY_JWT = 'JwtRefreshAuth';
export function JwtRefreshAuth() {
  return applyDecorators(
    SetMetadata(AUTH_KEY_JWT, true),
    UseGuards(JwtAuthGuard),
  );
}
