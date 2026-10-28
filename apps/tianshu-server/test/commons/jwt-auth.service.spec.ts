import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { JwtAuthService } from '../../src/commons/auth/jwt-auth.service';
import {
  IAuthConfig,
  IJwtPayload,
} from '../../src/commons/auth/interface/auth.interface';
import { TokenDto } from '../../src/commons/auth/token.dto';

describe('JwtAuthService', () => {
  let service: JwtAuthService;

  const mockAuthConfig: IAuthConfig = {
    defaultStrategy: 'jwt',
    global: true,
    jwt: {
      secret: 'test-secret-key',
      expiresIn: '1h',
      refreshExpiresIn: '7d',
    },
  };

  const mockConfigService = {
    get: jest.fn(),
  };

  const mockJwtService = {
    sign: jest.fn(),
    verify: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JwtAuthService,
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
        {
          provide: JwtService,
          useValue: mockJwtService,
        },
      ],
    }).compile();

    service = module.get<JwtAuthService>(JwtAuthService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('generateTokens', () => {
    const validPayload: IJwtPayload = {
      sub: '123',
      username: 'testuser',
      name: '测试用户',
      roles: ['user'],
    };

    it('should generate both access and refresh tokens successfully', () => {
      // Arrange
      const expectedAccessToken = 'mock-access-token';
      const expectedRefreshToken = 'mock-refresh-token';

      mockConfigService.get.mockReturnValue(mockAuthConfig);
      mockJwtService.sign
        .mockReturnValueOnce(expectedAccessToken)
        .mockReturnValueOnce(expectedRefreshToken);

      // Act
      const result: TokenDto = service.generateTokens(validPayload);

      // Assert
      expect(result).toEqual({
        accessToken: expectedAccessToken,
        refreshToken: expectedRefreshToken,
      });
      expect(mockConfigService.get).toHaveBeenCalledWith('auth');
      expect(mockJwtService.sign).toHaveBeenCalledTimes(2);
      expect(mockJwtService.sign).toHaveBeenNthCalledWith(1, validPayload, {
        secret: mockAuthConfig.jwt!.secret,
        expiresIn: mockAuthConfig.jwt!.expiresIn,
      });
      expect(mockJwtService.sign).toHaveBeenNthCalledWith(2, validPayload, {
        secret: mockAuthConfig.jwt!.secret,
        expiresIn: mockAuthConfig.jwt!.refreshExpiresIn,
      });
    });

    it('should throw error when payload is missing sub', () => {
      // Arrange
      const invalidPayload = {
        username: 'testuser',
        roles: ['user'],
      } as IJwtPayload;

      // Act & Assert
      expect(() => service.generateTokens(invalidPayload)).toThrow(
        'Invalid payload: sub and username are required',
      );
      expect(mockConfigService.get).not.toHaveBeenCalled();
      expect(mockJwtService.sign).not.toHaveBeenCalled();
    });

    it('should throw error when payload is missing username', () => {
      // Arrange
      const invalidPayload = {
        sub: '123',
        roles: ['user'],
      } as IJwtPayload;

      // Act & Assert
      expect(() => service.generateTokens(invalidPayload)).toThrow(
        'Invalid payload: sub and username are required',
      );
      expect(mockConfigService.get).not.toHaveBeenCalled();
      expect(mockJwtService.sign).not.toHaveBeenCalled();
    });

    it('should throw error when JWT configuration is missing secret', () => {
      // Arrange
      const invalidConfig = {
        ...mockAuthConfig,
        jwt: {
          ...mockAuthConfig.jwt!,
          secret: undefined,
        },
      };

      mockConfigService.get.mockReturnValue(invalidConfig);

      // Act & Assert
      expect(() => service.generateTokens(validPayload)).toThrow(
        'JWT configuration is missing',
      );
      expect(mockConfigService.get).toHaveBeenCalledWith('auth');
      expect(mockJwtService.sign).not.toHaveBeenCalled();
    });

    it('should throw error when JWT configuration is missing expiresIn', () => {
      // Arrange
      const invalidConfig = {
        ...mockAuthConfig,
        jwt: {
          ...mockAuthConfig.jwt!,
          expiresIn: undefined,
        },
      };

      mockConfigService.get.mockReturnValue(invalidConfig);

      // Act & Assert
      expect(() => service.generateTokens(validPayload)).toThrow(
        'JWT configuration is missing',
      );
      expect(mockConfigService.get).toHaveBeenCalledWith('auth');
      expect(mockJwtService.sign).not.toHaveBeenCalled();
    });

    it('should throw error when JWT configuration is missing refreshExpiresIn', () => {
      // Arrange
      const invalidConfig = {
        ...mockAuthConfig,
        jwt: {
          ...mockAuthConfig.jwt!,
          refreshExpiresIn: undefined,
        },
      };

      mockConfigService.get.mockReturnValue(invalidConfig);

      // Act & Assert
      expect(() => service.generateTokens(validPayload)).toThrow(
        'JWT configuration is missing',
      );
      expect(mockConfigService.get).toHaveBeenCalledWith('auth');
      // 第一次调用sign成功，第二次调用createRefreshToken时失败
      expect(mockJwtService.sign).toHaveBeenCalledTimes(1);
    });

    it('should throw error when auth configuration is null', () => {
      // Arrange
      mockConfigService.get.mockReturnValue(null);

      // Act & Assert
      expect(() => service.generateTokens(validPayload)).toThrow(
        'JWT configuration is missing',
      );
      expect(mockConfigService.get).toHaveBeenCalledWith('auth');
      expect(mockJwtService.sign).not.toHaveBeenCalled();
    });
  });

  describe('verifyToken', () => {
    const validToken = 'valid-jwt-token';
    const expectedPayload: IJwtPayload = {
      sub: '123',
      username: 'testuser',
      name: '测试用户',
      roles: ['user'],
      iat: 1640995200,
      exp: 1640998800,
    };

    it('should verify token successfully', () => {
      // Arrange
      mockConfigService.get.mockReturnValue(mockAuthConfig);
      mockJwtService.verify.mockReturnValue(expectedPayload);

      // Act
      const result: IJwtPayload = service.verifyToken(validToken);

      // Assert
      expect(result).toEqual(expectedPayload);
      expect(mockConfigService.get).toHaveBeenCalledWith('auth');
      expect(mockJwtService.verify).toHaveBeenCalledWith(validToken, {
        secret: mockAuthConfig.jwt!.secret,
      });
    });

    it('should throw error when JWT configuration is missing secret', () => {
      // Arrange
      const invalidConfig = {
        ...mockAuthConfig,
        jwt: {
          ...mockAuthConfig.jwt!,
          secret: undefined,
        },
      };

      mockConfigService.get.mockReturnValue(invalidConfig);

      // Act & Assert
      expect(() => service.verifyToken(validToken)).toThrow(
        'JWT configuration is missing',
      );
      expect(mockConfigService.get).toHaveBeenCalledWith('auth');
      expect(mockJwtService.verify).not.toHaveBeenCalled();
    });

    it('should throw error when auth configuration is null', () => {
      // Arrange
      mockConfigService.get.mockReturnValue(null);

      // Act & Assert
      expect(() => service.verifyToken(validToken)).toThrow(
        'JWT configuration is missing',
      );
      expect(mockConfigService.get).toHaveBeenCalledWith('auth');
      expect(mockJwtService.verify).not.toHaveBeenCalled();
    });

    it('should throw error when token is invalid', () => {
      // Arrange
      mockConfigService.get.mockReturnValue(mockAuthConfig);
      mockJwtService.verify.mockImplementation(() => {
        throw new Error('JsonWebTokenError: invalid token');
      });

      // Act & Assert
      expect(() => service.verifyToken(validToken)).toThrow(
        'Invalid or expired token',
      );
      expect(mockConfigService.get).toHaveBeenCalledWith('auth');
      expect(mockJwtService.verify).toHaveBeenCalledWith(validToken, {
        secret: mockAuthConfig.jwt!.secret,
      });
    });

    it('should throw error when token is expired', () => {
      // Arrange
      mockConfigService.get.mockReturnValue(mockAuthConfig);
      mockJwtService.verify.mockImplementation(() => {
        throw new Error('TokenExpiredError: jwt expired');
      });

      // Act & Assert
      expect(() => service.verifyToken(validToken)).toThrow(
        'Invalid or expired token',
      );
      expect(mockConfigService.get).toHaveBeenCalledWith('auth');
      expect(mockJwtService.verify).toHaveBeenCalledWith(validToken, {
        secret: mockAuthConfig.jwt!.secret,
      });
    });

    it('should throw error when JWT service throws unexpected error', () => {
      // Arrange
      mockConfigService.get.mockReturnValue(mockAuthConfig);
      mockJwtService.verify.mockImplementation(() => {
        throw new Error('Unexpected JWT error');
      });

      // Act & Assert
      expect(() => service.verifyToken(validToken)).toThrow(
        'Invalid or expired token',
      );
      expect(mockConfigService.get).toHaveBeenCalledWith('auth');
      expect(mockJwtService.verify).toHaveBeenCalledWith(validToken, {
        secret: mockAuthConfig.jwt!.secret,
      });
    });
  });
});
