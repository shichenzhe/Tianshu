import { describe, expect, it } from "vitest";

import {
  TEAM_MEMBERS_MAX,
  TEAM_MEMBER_ID_MAX,
  TEAM_MEMBER_ID_RE,
  applyTeamFields,
  emptyMemberRow,
  memberRowsReducer,
  trimMemberRows,
  validateTeamRows,
  type TeamMemberRow,
} from "./expert-team";

/** 合法成员行工厂（默认全字段有效，可局部覆盖） */
function memberRow(patch: Partial<TeamMemberRow> = {}): TeamMemberRow {
  return {
    id: "risk-officer",
    name: "小风",
    profession: "风控官",
    systemPrompt: "你是风控官。",
    ...patch,
  };
}

describe("validateTeamRows（校验纯函数，对齐桌面 create-expert 口径）", () => {
  it("空团队拒：零行 → empty", () => {
    expect(validateTeamRows([])).toEqual({ ok: false, code: "empty" });
  });

  it("合法单行通过：返回 trim 后的完整成员数组", () => {
    const result = validateTeamRows([
      memberRow({
        id: "  risk-officer  ",
        name: " 小风 ",
        profession: " 风控官 ",
        systemPrompt: " 你是风控官。 ",
      }),
    ]);
    expect(result).toEqual({
      ok: true,
      members: [
        {
          id: "risk-officer",
          name: "小风",
          profession: "风控官",
          systemPrompt: "你是风控官。",
        },
      ],
    });
  });

  it("条数上限：13 行通过，14 行 → tooMany", () => {
    const rows = Array.from({ length: TEAM_MEMBERS_MAX }, (_, index) =>
      memberRow({ id: `member-${index}` }),
    );
    expect(validateTeamRows(rows).ok).toBe(true);
    expect(validateTeamRows([...rows, memberRow({ id: "extra" })])).toEqual({
      ok: false,
      code: "tooMany",
    });
  });

  it("空 id 拒：整行其余字段合法但 id 空白 → idEmpty", () => {
    expect(validateTeamRows([memberRow({ id: "   " })])).toEqual({
      ok: false,
      code: "idEmpty",
    });
  });

  it("kebab 正则：大写/下划线/连字符开头/中文字符均拒，数字开头合法", () => {
    for (const bad of ["Risk-Officer", "risk_officer", "-risk", "风险官"]) {
      expect(validateTeamRows([memberRow({ id: bad })])).toEqual({
        ok: false,
        code: "idFormat",
      });
    }
    expect(validateTeamRows([memberRow({ id: "0-risk" })]).ok).toBe(true);
    // 正则常量本身钉死：^[a-z0-9][a-z0-9-]*$
    expect(TEAM_MEMBER_ID_RE.test("a")).toBe(true);
    expect(TEAM_MEMBER_ID_RE.test("9-x")).toBe(true);
    expect(TEAM_MEMBER_ID_RE.test("A")).toBe(false);
    expect(TEAM_MEMBER_ID_RE.test("-a")).toBe(false);
    expect(TEAM_MEMBER_ID_RE.test("a_b")).toBe(false);
  });

  it("id 长度边界：64 通过，65 → idTooLong（对齐 dispatch_member 上限）", () => {
    const id64 = `${"a".repeat(63)}9`;
    expect(id64.length).toBe(TEAM_MEMBER_ID_MAX);
    expect(validateTeamRows([memberRow({ id: id64 })]).ok).toBe(true);
    expect(validateTeamRows([memberRow({ id: `${id64}0` })])).toEqual({
      ok: false,
      code: "idTooLong",
    });
  });

  it("团内 id 唯一：重复 → idDuplicate（重复项排在全部单成员校验之后）", () => {
    const rows = [
      memberRow(),
      memberRow({ id: "risk-officer", name: "小风二号" }),
    ];
    expect(validateTeamRows(rows)).toEqual({
      ok: false,
      code: "idDuplicate",
    });
    expect(
      validateTeamRows([memberRow(), memberRow({ id: "data-analyst" })]).ok,
    ).toBe(true);
  });

  it("花名/头衔 1-30：空与 31 字符均拒", () => {
    expect(validateTeamRows([memberRow({ name: "" })])).toEqual({
      ok: false,
      code: "nameInvalid",
    });
    expect(validateTeamRows([memberRow({ name: "a".repeat(31) })])).toEqual({
      ok: false,
      code: "nameInvalid",
    });
    expect(validateTeamRows([memberRow({ name: "a".repeat(30) })]).ok).toBe(
      true,
    );
    expect(validateTeamRows([memberRow({ profession: "" })])).toEqual({
      ok: false,
      code: "professionInvalid",
    });
    expect(
      validateTeamRows([memberRow({ profession: "x".repeat(31) })]),
    ).toEqual({ ok: false, code: "professionInvalid" });
  });

  it("人设 1-20000：空与 20001 字符均拒，20000 通过", () => {
    expect(validateTeamRows([memberRow({ systemPrompt: "" })])).toEqual({
      ok: false,
      code: "promptInvalid",
    });
    expect(
      validateTeamRows([memberRow({ systemPrompt: "x".repeat(20001) })]),
    ).toEqual({ ok: false, code: "promptInvalid" });
    expect(
      validateTeamRows([memberRow({ systemPrompt: "x".repeat(20000) })]).ok,
    ).toBe(true);
  });

  it("首错优先：id 格式错先于重复 id 命中", () => {
    const rows = [
      memberRow({ id: "BAD" }),
      memberRow({ id: "BAD", name: "小风二号" }),
    ];
    expect(validateTeamRows(rows)).toEqual({ ok: false, code: "idFormat" });
  });
});

describe("memberRowsReducer（增删行/13 上限——组件切换的数据面）", () => {
  it("add：未满 13 追加空行，满员后不再追加（数组引用不变）", () => {
    let rows: TeamMemberRow[] = [];
    for (let index = 0; index < TEAM_MEMBERS_MAX; index += 1) {
      rows = memberRowsReducer(rows, { type: "add" });
    }
    expect(rows).toHaveLength(TEAM_MEMBERS_MAX);
    const capped = memberRowsReducer(rows, { type: "add" });
    expect(capped).toHaveLength(TEAM_MEMBERS_MAX);
    expect(capped).toBe(rows); // 上限拦截不建新引用
    expect(rows.every((row) => row.id === "")).toBe(true);
  });

  it("remove：按 index 滤除，原数组不动", () => {
    const rows = [memberRow({ id: "a" }), memberRow({ id: "b" })];
    const next = memberRowsReducer(rows, { type: "remove", index: 0 });
    expect(next.map((row) => row.id)).toEqual(["b"]);
    expect(rows).toHaveLength(2); // 不可变
  });

  it("update：index 定位浅合并 patch，越界原样返回", () => {
    const rows = [memberRow({ id: "a" })];
    const next = memberRowsReducer(rows, {
      type: "update",
      index: 0,
      patch: { name: "小风二号" },
    });
    expect(next[0]).toEqual({ ...memberRow({ id: "a" }), name: "小风二号" });
    expect(rows[0].name).toBe("小风"); // 不可变
    expect(
      memberRowsReducer(rows, {
        type: "update",
        index: 5,
        patch: { name: "x" },
      }),
    ).toBe(rows);
  });

  it("emptyMemberRow/trimMemberRows：占位全空串，trim 产出提交载荷", () => {
    expect(emptyMemberRow()).toEqual({
      id: "",
      name: "",
      profession: "",
      systemPrompt: "",
    });
    expect(trimMemberRows([memberRow({ id: " a ", name: " 小风 " })])).toEqual([
      {
        id: "a",
        name: "小风",
        profession: "风控官",
        systemPrompt: "你是风控官。",
      },
    ]);
  });
});

describe("applyTeamFields（buildPayload 三态）", () => {
  const member = {
    id: "risk-officer",
    name: "小风",
    profession: "风控官",
    systemPrompt: "你是风控官。",
  };

  it("新建 team：expertType team + 完整 members", () => {
    const payload: Record<string, unknown> = {};
    applyTeamFields(payload, {
      expertType: "team",
      members: [member],
      isNew: true,
      hadMembers: false,
    });
    expect(payload).toEqual({ expertType: "team", members: [member] });
  });

  it("编辑 team 回填：同样提交 team + members（整组覆盖）", () => {
    const payload: Record<string, unknown> = {};
    applyTeamFields(payload, {
      expertType: "team",
      members: [member],
      isNew: false,
      hadMembers: true,
    });
    expect(payload).toEqual({ expertType: "team", members: [member] });
  });

  it("team→agent 清列：编辑态显式 expertType agent + members null", () => {
    const payload: Record<string, unknown> = {};
    applyTeamFields(payload, {
      expertType: "agent",
      members: [],
      isNew: false,
      hadMembers: true, // 原为团队
    });
    expect(payload).toEqual({ expertType: "agent", members: null });
  });

  it("编辑 agent 常态：expertType agent，原无成员则 members 省略不动列", () => {
    const payload: Record<string, unknown> = {};
    applyTeamFields(payload, {
      expertType: "agent",
      members: [],
      isNew: false,
      hadMembers: false,
    });
    expect(payload).toEqual({ expertType: "agent" });
    expect("members" in payload).toBe(false);
  });

  it("新建 agent 常态：两键均省略（默认单专家语义，不传即保留）", () => {
    const payload: Record<string, unknown> = {};
    applyTeamFields(payload, {
      expertType: "agent",
      members: [],
      isNew: true,
      hadMembers: false,
    });
    expect(payload).toEqual({});
    expect("expertType" in payload).toBe(false);
    expect("members" in payload).toBe(false);
  });
});
