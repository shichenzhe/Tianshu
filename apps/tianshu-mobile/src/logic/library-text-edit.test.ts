// 资料库文本编辑视图数据面（资料库编辑批）：状态机纯函数全边界——
// 加载/就绪/失败三态、草稿变更、保存锁、未改动判定（取消确认前提）。
import { describe, expect, it } from "vitest";

import {
  editDraftChanged,
  editLoadFailed,
  editLoaded,
  editSaveSettled,
  editSaveStarted,
  hasUnsavedChanges,
  initialEditState,
} from "./library-text-edit";

describe("library-text-edit 编辑状态机", () => {
  it("初始 loading；加载成功就绪（原稿=草稿）；加载失败 failed", () => {
    expect(initialEditState()).toEqual({ status: "loading" });
    const ready = editLoaded("# 标题");
    expect(ready).toEqual({
      status: "ready",
      original: "# 标题",
      draft: "# 标题",
      saving: false,
    });
    expect(editLoadFailed()).toEqual({ status: "failed" });
  });

  it("就绪态草稿可改；loading/failed 态忽略；保存中忽略（防迟到覆盖）", () => {
    const ready = editLoaded("a");
    expect(editDraftChanged(ready, "ab")).toMatchObject({ draft: "ab" });
    expect(editDraftChanged(initialEditState(), "x")).toEqual({
      status: "loading",
    });
    expect(editDraftChanged(editLoadFailed(), "x")).toEqual({
      status: "failed",
    });
    const saving = editSaveStarted(ready);
    expect(editDraftChanged(saving, "迟到输入")).toEqual(saving);
  });

  it("保存锁：started 置 saving，settled 复位；非就绪态原样", () => {
    const ready = editLoaded("a");
    const saving = editSaveStarted(ready);
    expect(saving).toMatchObject({ saving: true });
    expect(editSaveSettled(saving)).toMatchObject({ saving: false });
    expect(editSaveStarted(initialEditState())).toEqual({ status: "loading" });
    expect(editSaveSettled(editLoadFailed())).toEqual({ status: "failed" });
  });

  it("未改动判定：草稿==原稿无改动（取消直退）；不等即有改动（先确认）", () => {
    expect(hasUnsavedChanges(initialEditState())).toBe(false);
    expect(hasUnsavedChanges(editLoadFailed())).toBe(false);
    expect(hasUnsavedChanges(editLoaded("a"))).toBe(false);
    const changed = editDraftChanged(editLoaded("a"), "ab");
    expect(hasUnsavedChanges(changed)).toBe(true);
    // 改回原文 = 无改动（按内容判定非按是否敲过键盘）
    const reverted = editDraftChanged(editLoaded("a"), "a");
    expect(hasUnsavedChanges(reverted)).toBe(false);
  });
});
