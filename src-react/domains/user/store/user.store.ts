/**
 * 用户 Store
 * 使用 Zustand 管理用户状态
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * 用户基础信息
 */
export interface UserBase {
  id: number;
  username: string;
  nickname: string;
  email: string;
}

/**
 * 用户认证信息（包含 token）
 */
export interface UserAuth extends UserBase {
  token: string;
}

/**
 * 用户状态
 */
interface UserState {
  user: UserAuth & { expiresAt: number | null };
}

/**
 * 用户操作
 */
interface UserActions {
  setUserInfo: (data: UserBase & { token?: string }) => void;
  setExpiration: (expiresAt: number | null) => void;
  isLoginValid: () => boolean;
  reset: () => void;
}

/**
 * 用户 Store 类型
 */
type UserStore = UserState & UserActions;

/**
 * 初始状态
 */
const initialState: UserAuth & { expiresAt: number | null } = {
  id: 0,
  username: "",
  nickname: "",
  email: "",
  token: "",
  expiresAt: null,
};

/**
 * 创建用户 Store
 */
export const useUserStore = create<UserStore>()(
  persist(
    (set, get) => ({
      // 状态
      user: initialState,

      // 操作
      setUserInfo: (data) => {
        set((state) => ({
          user: { ...state.user, ...data },
        }));
      },

      setExpiration: (expiresAt) => {
        set((state) => ({
          user: { ...state.user, expiresAt },
        }));
      },

      isLoginValid: () => {
        const { user } = get();
        // 如果没有 token，则未登录
        if (!user.token) return false;
        // 如果没有过期时间，则是会话级登录（关闭浏览器后失效）
        if (user.expiresAt === null) return true;
        // 检查是否过期
        return Date.now() < user.expiresAt;
      },

      reset: () => {
        set({
          user: initialState,
        });
      },
    }),
    {
      name: "userInfo",
      partialize: (state) => ({ user: state.user }),
    },
  ),
);
