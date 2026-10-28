/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{ts,tsx}"],
  // class 策略：media 策略下 web 侧 css-interop 的 head MutationObserver 会
  // 在样式注入后调 colorScheme.set("system") 触发 "Cannot manually set color
  // scheme" 崩溃（dev error-overlay 挡交互）；且天枢桌面端皮肤本就是应用
  // 自管（data-mode），非跟随 OS——移动端后续接手动切换（T11）。
  darkMode: "class",
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      // iOS 系统语义色（去AI味批 GL）：中性面/文字层级统一令牌，暗色经
      // dark: 前缀显式配对（grouped 暗=black、card 暗=#1C1C1E、field 暗
      // =#2C2C2E——配对值写在用法处）；对齐 iOS 26 系统色板
      colors: {
        grouped: "#F2F2F7",
        card: "#FFFFFF",
        field: "#E9E9EB",
        sep: "rgba(60,60,67,0.12)",
        label2: "rgba(60,60,67,0.60)",
        label3: "rgba(60,60,67,0.30)",
      },
    },
  },
  plugins: [],
};
