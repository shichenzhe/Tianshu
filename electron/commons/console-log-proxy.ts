import Log from "./Log";

export default class ConsoleLogProxy {
  constructor() {
    // 保存原始的 console 方法
    const originalInfo = console.info;
    const originalWarn = console.warn;
    const originalError = console.error;
    const isDevelopment = process.env.NODE_ENV === "development";
    // 覆盖 console.info
    console.info = function (...args) {
      if (isDevelopment) {
        originalInfo.apply(console, [""].concat(args));
      } else {
        Log.info(args);
      }
    };

    // 覆盖 console.warn
    console.warn = function (...args) {
      if (isDevelopment) {
        originalWarn.apply(console, [""].concat(args));
      } else {
        Log.warn(args);
      }
    };

    // 覆盖 console.error
    console.error = function (...args) {
      if (isDevelopment) {
        originalError.apply(console, [""].concat(args));
      } else {
        Log.error(args);
      }
    };
  }
}
