# 如何添加业务模块

以模板自带的 **user 模块**为参照，新增一个业务模块共七步。假设新模块叫 `note`。

## 第 1 步：建表（Prisma）

`prisma/schema.prisma` 追加 model（继承 StandardEntity 审计字段风格）：

```prisma
model note {
  id        String   @id @default(uuid())
  title     String
  content   String?
  createdAt DateTime @default(now()) @map("created_at")
  creatorId String   @map("creator_id")

  @@map("note")
}
```

执行 `npx prisma generate`。若用 PostgreSQL，同步修改 `schema.prisma.postgresql`。
本地开发直接 `npm run prisma:reset` 重建库（会清空数据）。

## 第 2 步：entity（库表实体 + 查询解码）

- `src/modules/note/entity/note.entity.ts`：类的字段与 model 一一对应（参考 user.entity.ts）
- `src/modules/note/entity/note.queryfilter.ts`：继承 `QueryFilter`，声明列表过滤字段（keyword、title 等）
- `src/modules/note/entity/note.querydecoder.ts`：把 queryfilter 翻译成 Prisma `where`（参考 user.querydecoder.ts）

## 第 3 步：repository

`src/modules/note/note.repository.ts`：薄封装 Prisma 访问（findMany/create/update/delete），不放业务逻辑（参考 user.repository.ts）。

## 第 4 步：dto

`src/modules/note/dto/`：

- `note-create.dto.ts` / `note-update.dto.ts`：入参 + class-validator 校验（中文错误消息）
- `note.dto.ts`：出参，`@Expose()` 白名单 + `static create()` 转换

## 第 5 步：service

`src/modules/note/note.service.ts`：业务逻辑与校验；错误一律 `throw new BusinessException(ErrorCode.xxx, '说明')`（参考 user.service.ts）。

## 第 6 步：controller

`src/modules/note/note.controller.ts`：POST 风格路由 + 守卫 + Swagger 注解：

```typescript
@Controller('note')
export class NoteController {
  constructor(private readonly noteService: NoteService) {}

  @Post('create')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserType.admin)
  @ApiOperation({ summary: '创建笔记' })
  async create(
    @Body() dto: NoteCreateDto,
    @AccessContext() operateContext: OperateContext,
  ): Promise<NoteDto> {
    return this.noteService.create(dto, operateContext);
  }

  @Post('query')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '笔记列表' })
  async query(@Body() filter: NoteQueryFilter): Promise<QueryResult<NoteDto>> {
    return this.noteService.query(filter);
  }
}
```

## 第 7 步：模块接线

- 新建 `src/modules/note/note.module.ts`（参考 user.module.ts，注册 controller/providers、导入 PrismaModule）
- `src/app.module.ts` 的 imports 追加 `NoteModule`

（可选）操作日志为全局拦截器（`OperationLogInterceptor`，已在 app.module 全局注册），源工程以开关方式禁用——当前 `src/modules/operationlog/operation-log.interceptor.ts` 中 `DISABLE_LOG = true`，任何接口都不会落库。需要开启时，把该开关改为 `false` 即可自动记录接口调用（用户/IP/耗时/状态）；个别接口如需跳过记录，可用 `@SkipOperationLog()` 装饰器标注。

完成。删模块 = 反向删除这七步产物。
