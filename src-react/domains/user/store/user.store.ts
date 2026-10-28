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

// 登录态变化上报主进程（问题 2 方案 A，2026-10-22）：被控面
// resolveUserId / info 身份跟随渲染层真实登录用户（此前主进程无从感知
// 登录态，只能猜 user 表最新一行——切回更早注册的账号登录即错位）。
// 登录/切换 id 变化上报新值；登出/未登录（id=0）上报 null；rehydrate
// 恢复登录态（0→id）同样触发。上报失败静默——回落旧「最新用户」语义。
// 已知简化：token 过期未重登期间不上报清除（过期是动态判断不触发
// state 变化），重新登录后即纠正。
function reportLoginUserToMain(): void {
  // 防御：单测环境无 window（node）或无 preload 注入（jsdom）——经
  // globalThis 属性访问（裸 window 标识符会被转换层静态替换致防不住），
  // optional chain 全吞，回落主进程「user 表最新」旧语义
  const bridge = (
    globalThis as {
      window?: {
        ipcRenderer?: {
          invoke: (channel: string, value: unknown) => Promise<unknown>;
        };
      };
    }
  ).window?.ipcRenderer;
  void bridge
    ?.invoke(
      "serverFace:reportActiveUser",
      useUserStore.getState().user.id || null,
    )
    .catch(() => undefined);
}

useUserStore.subscribe((state, prev) => {
  if (state.user.id === prev.user.id) return;
  reportLoginUserToMain();
});

// 模块加载直报一次：persist rehydrate 在 create() 内部同步完成，晚于
// 此处注册的 subscribe 收不到（0→id），启动恢复登录态场景由此覆盖
reportLoginUserToMain();
