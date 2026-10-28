import * as bcrypt from 'bcrypt';
/**
 * 密码加密工具类。
 */
export class PasswordEncryptUtil {
  /**
   * 加密。
   * @param plainText
   * 明文，not null。
   * @returns 密文。
   */
  static async encode(plainText: string): Promise<string> {
    return await bcrypt.hash(plainText, 10);
  }

  /**
   * 校验。
   * @param plainText
   * 明文，not null。
   * @param hash
   * 密文，not null。
   * @returns
   */
  static async compare(plainText: string, hash: string): Promise<boolean> {
    return await bcrypt.compare(plainText, hash);
  }
}
