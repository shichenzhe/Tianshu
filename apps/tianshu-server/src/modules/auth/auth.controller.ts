import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthService } from '../../commons/auth/jwt-auth.service';
import { TokenRefreshDto } from './dto/token-refresh.dto';
import { TokenDto } from '../../commons/auth/token.dto';
import { Public } from 'src/commons/auth/decorator/public.decorator';
import { RolesGuard } from 'src/commons/auth/roles.guard';
import { JwtAuthGuard } from 'src/commons/auth/guard/jwt-auth.guard';
import { UserType } from '@prisma/client';
import { Roles } from 'src/commons/auth/roles.decorator';
import { UserChangePasswordDto } from './dto/user-change-password.dto';
import { OperateContext } from 'src/commons/entity/operate-context.entity';
import { AccessContext } from 'src/commons/auth/decorator/access-context.decorator';
import { UserService } from '../user/user.service';
import { LoginDto, LoginResponseDto } from './dto/login.dto';
import { UserDto } from '../user/dto/user.dto';
import { UserUpdateDto } from '../user/dto/user-update.dto';
import { UserEntity } from '../user/entity/user.entity';
import { UserProfileUpdateDto } from './dto/user-profile-update.dto';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly jwtAuthService: JwtAuthService,
    private readonly userService: UserService,
  ) {}
  /**
   * 用户登录
   */
  @Post('login')
  @Public()
  @HttpCode(HttpStatus.OK)
  async login(@Body() loginDto: LoginDto): Promise<LoginResponseDto> {
    return this.userService.login(loginDto);
  }
  /**
   * 刷新访问令牌
   */
  @Post('refresh')
  @Public()
  refreshToken(@Body() refreshTokenDto: TokenRefreshDto): TokenDto {
    try {
      // 验证刷新令牌
      const payload = this.jwtAuthService.verifyToken(
        refreshTokenDto.refreshToken,
      );

      // 生成新的访问令牌和刷新令牌
      return this.jwtAuthService.generateTokens(payload);
    } catch {
      throw new UnauthorizedException('登录会话已过期：令牌无效或已过期');
    }
  }

  /**
   * 修改密码
   */
  @Post('changePassword')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserType.admin, UserType.user)
  async changePassword(
    @Body() changePasswordDto: UserChangePasswordDto,
    @AccessContext() operateContext: OperateContext,
  ): Promise<{ message: string }> {
    await this.userService.changePassword(
      operateContext.operator.id,
      changePasswordDto,
      operateContext,
    );
    return { message: '密码修改成功，请重新登录' };
  }

  /**
   * 获取用户详情
   */
  @Post('profile/get')
  @UseGuards(JwtAuthGuard)
  async getProfile(
    @AccessContext() operateContext: OperateContext,
  ): Promise<UserDto | null> {
    const userEntity = await this.userService.getById(
      operateContext.operator.id,
    );
    if (!userEntity) {
      return null;
    }
    return UserDto.create(userEntity);
  }

  /**
   * 更新用户信息
   */
  @Post('profile/update')
  @UseGuards(JwtAuthGuard)
  async update(
    @Body() updateUserDto: UserProfileUpdateDto,
    @AccessContext() operateContext: OperateContext,
  ): Promise<UserDto> {
    const entity: UserUpdateDto = new UserUpdateDto(updateUserDto);
    entity.id = operateContext.operator.id;
    entity.isActive = true;
    entity.email = updateUserDto.email;
    entity.name = updateUserDto.name;
    entity.phone = updateUserDto.phone;
    entity.note = updateUserDto.note;

    const userEntity: UserEntity = await this.userService.update(
      entity,
      operateContext,
    );
    return UserDto.create(userEntity);
  }
}
