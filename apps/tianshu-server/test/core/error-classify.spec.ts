import { classifyError } from '@tianshu/core';

// 移植自 mirror tests/ai/error-classify.test.ts（a39cd41）

describe('错误分类', () => {
  it('401/403 → AUTH_FAILED', () => {
    expect(classifyError({ statusCode: 401 })).toBe('AUTH_FAILED');
    expect(classifyError({ statusCode: 403 })).toBe('AUTH_FAILED');
  });

  it('404 → MODEL_NOT_FOUND', () => {
    expect(classifyError({ statusCode: 404 })).toBe('MODEL_NOT_FOUND');
  });

  it('429 → RATE_LIMITED', () => {
    expect(classifyError({ statusCode: 429 })).toBe('RATE_LIMITED');
  });

  it('status 形状（LangChain provider 透传的 openai/anthropic SDK APIError）401/403 → AUTH_FAILED', () => {
    expect(classifyError({ status: 401 })).toBe('AUTH_FAILED');
    expect(
      classifyError(Object.assign(new Error('Forbidden'), { status: 403 })),
    ).toBe('AUTH_FAILED');
  });

  it('status 形状 429 → RATE_LIMITED', () => {
    expect(classifyError({ status: 429 })).toBe('RATE_LIMITED');
  });

  it('status 形状 404 → MODEL_NOT_FOUND', () => {
    expect(
      classifyError(
        Object.assign(new Error('model not found'), { status: 404 }),
      ),
    ).toBe('MODEL_NOT_FOUND');
  });

  it('400 + 图片关键字 → IMAGE_UNSUPPORTED（非视觉模型收到 image part）', () => {
    expect(
      classifyError({
        statusCode: 400,
        message: 'This model does not support image inputs',
      }),
    ).toBe('IMAGE_UNSUPPORTED');
    expect(
      classifyError({ statusCode: 400, message: 'vision input unsupported' }),
    ).toBe('IMAGE_UNSUPPORTED');
  });

  it('400 无图片关键字 → UNKNOWN（保持通用兜底）', () => {
    expect(classifyError({ statusCode: 400, message: 'bad request' })).toBe(
      'UNKNOWN',
    );
  });

  it('超时关键字 → TIMEOUT', () => {
    expect(classifyError(new Error('Request timed out'))).toBe('TIMEOUT');
  });

  it('fetch failed → NETWORK', () => {
    expect(classifyError(new TypeError('fetch failed'))).toBe('NETWORK');
  });

  it('其他 → UNKNOWN', () => {
    expect(classifyError(new Error('whatever'))).toBe('UNKNOWN');
    expect(classifyError('str')).toBe('UNKNOWN');
  });
});
