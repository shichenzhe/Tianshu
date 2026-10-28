import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Logger } from '../../commons/log/logger';
import { LoggerFactory } from '../../commons/log/logger-factory';
import { JwtAuthService } from '../../commons/auth/jwt-auth.service';
import { UserRepository } from './user.repository';
import { LoginDto, LoginResponseDto } from '../auth/dto/login.dto';
import { UserQueryFilter } from './entity/user.queryfilter';
import { QueryResult } from 'src/commons/query/query-result';
import { UserEntity } from './entity/user.entity';
import { BusinessException } from 'src/commons/exception/bussiness-exception';
import { ErrorCodeEnum } from 'src/commons/exception/error-code.enum';
import { IJwtPayload } from 'src/commons/auth/interface/auth.interface';
import { PasswordEncryptUtil } from 'src/commons/util/password-encrypt.util';
import { OperateContext } from 'src/commons/entity/operate-context.entity';
import { UserUpdateEntity } from './entity/user-update.entity';
import { UserActiveEntity } from './entity/user-active.entity';
import { UserChangePasswordEntity } from './entity/user-change-password.entity';
import { UserCreateDto } from './dto/user-create.dto';
import { UserUpdateDto } from './dto/user-update.dto';
import { UserChangePasswordDto } from '../auth/dto/user-change-password.dto';
import { UserCreateEntity } from './entity/user-create.entity';

@Injectable()
export class UserService {
  private readonly logger: Logger;

  constructor(
    private readonly factory: LoggerFactory,
    private readonly userRepository: UserRepository,
    private readonly jwtAuthService: JwtAuthService,
  ) {
    this.logger = this.factory.create('UserService');
  }

  /**
   * 用户登录
   */
  async login(loginDto: LoginDto): Promise<LoginResponseDto> {
    this.logger.info(`用户登录尝试: ${loginDto.username}`);

    // 查找用户
    const user = await this.userRepository.getByUsername(loginDto.username);
    if (!user || !user.isActive) {
      throw new BusinessException(
        '用户名或密码错误',
        ErrorCodeEnum.UNAUTHORIZED,
      );
    }

    // 验证密码
    const isPasswordValid = await PasswordEncryptUtil.compare(
      loginDto.password,
      user.passwordHash,
    );
    if (!isPasswordValid) {
      throw new BusinessException(
        '用户名或密码错误',
        ErrorCodeEnum.UNAUTHORIZED,
      );
    }

    // 生成JWT令牌
    const payload: IJwtPayload = {
      sub: user.id,
      username: user.username,
      name: user.name,
      roles: user.getRoles(),
    };

    const tokens = this.jwtAuthService.generateTokens(payload);

    // 更新最后登录时间
    await this.userRepository.updateLastLoginTime(user.id);

    this.logger.info(`用户登录成功: ${user.username}`);

    return LoginResponseDto.create({
      ...tokens,
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        userType: user.userType,
        phone: user.phone,
        email: user.email,
        note: user.note,
      },
    });
  }

  /**
   * 创建用户
   */
  async create(
    createUserDto: UserCreateDto,
    operateContext: OperateContext,
  ): Promise<UserEntity> {
    // 检查用户名是否已存在
    const existingUser = await this.userRepository.existsByUsername(
      createUserDto.username,
    );
    if (existingUser) {
      throw new ConflictException('用户名已存在');
    }

    // 加密密码
    const passwordHash = await PasswordEncryptUtil.encode(
      createUserDto.password,
    );
    const userPo = UserCreateEntity.create(createUserDto);
    userPo.onCreated(operateContext);
    userPo.onUpdated(operateContext);
    userPo.passwordHash = passwordHash;
    const user = await this.userRepository.create(userPo);
    return user;
  }

  /**
   * 更新用户信息
   */
  async update(
    updateUserDto: UserUpdateDto,
    operateContext: OperateContext,
  ): Promise<UserEntity> {
    // 检查用户是否存在
    const existingUser = await this.userRepository.getById(updateUserDto.id);
    if (!existingUser) {
      throw new NotFoundException('用户不存在');
    }

    const updateUserPo = UserUpdateEntity.create(updateUserDto);
    updateUserPo.onUpdated(operateContext);

    const user = await this.userRepository.update(
      updateUserDto.id,
      updateUserPo,
    );
    return user;
  }

  /**
   * 获取用户信息
   */
  async getById(id: string): Promise<UserEntity | null> {
    const user = await this.userRepository.getById(id);
    return user;
  }

  /**
   * 获取用户列表
   */
  async query(params: UserQueryFilter): Promise<QueryResult<UserEntity>> {
    return await this.userRepository.query(params);
  }

  /**
   * 获取用户列表
   */
  async list(params: UserQueryFilter): Promise<UserEntity[]> {
    return await this.userRepository.list(params);
  }

  /**
   * 更新用户状态
   */
  async active(
    id: string,
    isActive: boolean,
    operateContext: OperateContext,
  ): Promise<void> {
    // 检查用户是否存在
    const existingUser = await this.userRepository.getById(id);
    if (!existingUser) {
      throw new NotFoundException('用户不存在');
    }

    // 检查是否为admin用户
    if (existingUser.username === 'admin') {
      throw new ConflictException('admin用户不能启用/禁用');
    }

    const entity = new UserActiveEntity({
      isActive,
    });
    entity.onUpdated(operateContext);

    await this.userRepository.active(id, entity);
  }

  /**
   * 重置密码
   */
  async resetPassword(
    id: string,
    operateContext: OperateContext,
  ): Promise<void> {
    // 检查用户是否存在
    const user = await this.userRepository.getById(id);
    if (!user) {
      throw new NotFoundException('用户不存在');
    }

    // 加密新密码
    const newPasswordHash = await PasswordEncryptUtil.encode('123456');
    const updateUserPasswordEntity = new UserChangePasswordEntity({
      passwordHash: newPasswordHash,
    });
    updateUserPasswordEntity.onUpdated(operateContext);
    await this.userRepository.changePassword(id, updateUserPasswordEntity);
  }

  /**
   * 修改密码
   */
  async changePassword(
    id: string,
    updatePasswordDto: UserChangePasswordDto,
    operateContext: OperateContext,
  ): Promise<void> {
    // 验证新密码和确认密码是否一致
    if (updatePasswordDto.newPassword !== updatePasswordDto.confirmPassword) {
      throw new BadRequestException('新密码和确认密码不一致');
    }

    // 检查用户是否存在
    const user = await this.userRepository.getById(id);
    if (!user) {
      throw new NotFoundException('用户不存在');
    }

    // 验证原密码
    const isOldPasswordValid = await PasswordEncryptUtil.compare(
      updatePasswordDto.oldPassword,
      user.passwordHash,
    );
    if (!isOldPasswordValid) {
      throw new BadRequestException('原密码不正确');
    }

    // 加密新密码
    const newPasswordHash = await PasswordEncryptUtil.encode(
      updatePasswordDto.newPassword,
    );
    const updateUserPasswordEntity = new UserChangePasswordEntity({
      passwordHash: newPasswordHash,
    });
    updateUserPasswordEntity.onUpdated(operateContext);
    await this.userRepository.changePassword(id, updateUserPasswordEntity);
  }

  /**
   * 物理删除用户
   */
  async delete(id: string): Promise<void> {
    // 检查用户是否存在
    const existingUser = await this.userRepository.getById(id);
    if (!existingUser) {
      throw new NotFoundException('用户不存在');
    }

    // 检查是否为admin用户
    if (existingUser.username === 'admin') {
      throw new ConflictException('admin用户不能删除');
    }

    // 执行物理删除
    await this.userRepository.delete(id);
  }
}
