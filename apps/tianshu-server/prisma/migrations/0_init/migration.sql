-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "user_type" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "email" TEXT,
    "last_login_time" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creator_id" TEXT NOT NULL,
    "creator_name" TEXT NOT NULL,
    "updated_at" DATETIME NOT NULL,
    "updator_id" TEXT NOT NULL,
    "updator_name" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "operation_log" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "details" JSONB,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "execution_time" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'SUCCESS',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "option" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "note" TEXT
);

-- CreateTable
CREATE TABLE "provider" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "apiKey" TEXT,
    "extraHeaders" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "userId" INTEGER
);

-- CreateTable
CREATE TABLE "model" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "providerId" INTEGER NOT NULL,
    "modelId" TEXT NOT NULL,
    "name" TEXT,
    "type" TEXT NOT NULL DEFAULT 'llm',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "temperature" REAL,
    "topP" REAL,
    "maxTokens" INTEGER,
    "contextWindow" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "assistant" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "icon" TEXT,
    "systemPrompt" TEXT NOT NULL,
    "temperature" REAL,
    "topP" REAL,
    "maxTokens" INTEGER,
    "builtin" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "tags" TEXT,
    "sourceSlug" TEXT,
    "profession" TEXT,
    "quickPrompts" TEXT,
    "categoryId" TEXT,
    "skillNames" TEXT,
    "expertType" TEXT,
    "members" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "userId" INTEGER
);

-- CreateTable
CREATE TABLE "workspace" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "icon" TEXT,
    "directoryPath" TEXT,
    "defaultModelId" INTEGER,
    "writeApprovedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "projectId" INTEGER,
    "userId" INTEGER
);

-- CreateTable
CREATE TABLE "session" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "workspaceId" INTEGER NOT NULL,
    "assistantId" INTEGER,
    "currentModelId" INTEGER,
    "title" TEXT NOT NULL DEFAULT '新会话',
    "mode" TEXT,
    "scenario" TEXT,
    "pinnedAt" DATETIME,
    "archivedAt" DATETIME,
    "projectId" INTEGER,
    "summary" TEXT,
    "compactedUpToId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "lastMessageAt" DATETIME,
    "userId" INTEGER,
    "planItemId" INTEGER,
    "lastReadMessageId" INTEGER
);

-- CreateTable
CREATE TABLE "message" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "sessionId" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "blocks" TEXT NOT NULL,
    "modelId" INTEGER,
    "assistantId" INTEGER,
    "error" TEXT,
    "durationMs" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "project" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "systemPrompt" TEXT,
    "templateKey" TEXT,
    "ownerId" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "planItem" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "projectId" INTEGER,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'not_started',
    "priority" TEXT NOT NULL DEFAULT 'P1',
    "assigneeId" INTEGER,
    "tags" TEXT,
    "customFields" TEXT,
    "startDate" DATETIME,
    "dueDate" DATETIME,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "description" TEXT,
    "aiSummary" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdById" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "graphDefinition" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "graphJson" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "userId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "automationTask" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "modelId" INTEGER NOT NULL,
    "temperature" REAL,
    "scheduleJson" TEXT NOT NULL,
    "scheduleText" TEXT NOT NULL,
    "startAt" DATETIME,
    "endAt" DATETIME,
    "missedPolicy" TEXT NOT NULL DEFAULT 'skip',
    "accessMode" TEXT NOT NULL DEFAULT 'default',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'active',
    "statusNote" TEXT,
    "lastRunAt" DATETIME,
    "nextRunAt" DATETIME,
    "templateSlug" TEXT,
    "targetKind" TEXT NOT NULL DEFAULT 'prompt',
    "graphId" INTEGER,
    "eventJson" TEXT,
    "projectId" INTEGER,
    "userId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "automationRun" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "taskId" INTEGER,
    "sessionId" INTEGER,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "triggerType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "durationMs" INTEGER,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "graphId" INTEGER,
    "graphTrace" TEXT,
    "error" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME
);

-- CreateTable
CREATE TABLE "graphRunNode" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "runId" INTEGER NOT NULL,
    "nodeId" TEXT NOT NULL,
    "nodeName" TEXT,
    "status" TEXT NOT NULL,
    "input" TEXT,
    "output" TEXT,
    "errorJson" TEXT,
    "toolCallsJson" TEXT,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "durationMs" INTEGER NOT NULL,
    "startedAt" TEXT NOT NULL,
    "outputImage" TEXT,
    "errorOutput" TEXT,
    "fallbackJson" TEXT
);

-- CreateTable
CREATE TABLE "automationStat" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "event" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "vectorChunk" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER,
    "collection" TEXT NOT NULL,
    "sourceName" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "vector" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "skillRecord" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "slug" TEXT,
    "version" TEXT,
    "source" TEXT NOT NULL,
    "dir" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "scenarios" TEXT,
    "installedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "skillStat" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "libraryItem" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "parentId" INTEGER,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fileType" TEXT,
    "mimeType" TEXT,
    "size" INTEGER,
    "originalPath" TEXT,
    "url" TEXT,
    "favorite" BOOLEAN NOT NULL DEFAULT false,
    "lastViewedAt" DATETIME,
    "userId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "toolPermission" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "workspaceId" INTEGER NOT NULL,
    "toolName" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "llmCallEvent" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER,
    "scene" TEXT NOT NULL,
    "modelId" INTEGER,
    "sessionId" INTEGER,
    "graphId" INTEGER,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "durationMs" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "toolCallEvent" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER,
    "scene" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "durationMs" INTEGER,
    "sessionId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "user_username_key" ON "user"("username");

-- CreateIndex
CREATE INDEX "user_username_idx" ON "user"("username");

-- CreateIndex
CREATE INDEX "user_user_type_idx" ON "user"("user_type");

-- CreateIndex
CREATE INDEX "user_is_active_idx" ON "user"("is_active");

-- CreateIndex
CREATE INDEX "user_phone_idx" ON "user"("phone");

-- CreateIndex
CREATE INDEX "user_last_login_time_idx" ON "user"("last_login_time" DESC);

-- CreateIndex
CREATE INDEX "operation_log_user_id_idx" ON "operation_log"("user_id");

-- CreateIndex
CREATE INDEX "operation_log_created_at_idx" ON "operation_log"("created_at" DESC);

-- CreateIndex
CREATE INDEX "operation_log_operation_idx" ON "operation_log"("operation");

-- CreateIndex
CREATE INDEX "operation_log_status_idx" ON "operation_log"("status");

-- CreateIndex
CREATE INDEX "operation_log_ip_address_idx" ON "operation_log"("ip_address");

-- CreateIndex
CREATE INDEX "option_type_index" ON "option"("type");

-- CreateIndex
CREATE UNIQUE INDEX "idx_option_type_name" ON "option"("type", "name");

-- CreateIndex
CREATE INDEX "provider_userId_index" ON "provider"("userId");

-- CreateIndex
CREATE INDEX "model_providerId_idx" ON "model"("providerId");

-- CreateIndex
CREATE INDEX "assistant_userId_index" ON "assistant"("userId");

-- CreateIndex
CREATE INDEX "workspace_projectId_index" ON "workspace"("projectId");

-- CreateIndex
CREATE INDEX "workspace_userId_index" ON "workspace"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_userId_name_key" ON "workspace"("userId", "name");

-- CreateIndex
CREATE INDEX "session_projectId_index" ON "session"("projectId");

-- CreateIndex
CREATE INDEX "session_userId_index" ON "session"("userId");

-- CreateIndex
CREATE INDEX "session_workspaceId_index" ON "session"("workspaceId");

-- CreateIndex
CREATE INDEX "message_sessionId_idx" ON "message"("sessionId");

-- CreateIndex
CREATE INDEX "message_createdAt_index" ON "message"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "idx_project_owner_name" ON "project"("ownerId", "name");

-- CreateIndex
CREATE INDEX "planItem_projectId_idx" ON "planItem"("projectId");

-- CreateIndex
CREATE INDEX "planItem_assigneeId_idx" ON "planItem"("assigneeId");

-- CreateIndex
CREATE INDEX "graphDefinition_userId_index" ON "graphDefinition"("userId");

-- CreateIndex
CREATE INDEX "automationTask_enabled_idx" ON "automationTask"("enabled");

-- CreateIndex
CREATE INDEX "automation_task_projectId_index" ON "automationTask"("projectId");

-- CreateIndex
CREATE INDEX "automation_task_userId_index" ON "automationTask"("userId");

-- CreateIndex
CREATE INDEX "automationRun_taskId_idx" ON "automationRun"("taskId");

-- CreateIndex
CREATE INDEX "automationRun_graphId_index" ON "automationRun"("graphId");

-- CreateIndex
CREATE INDEX "automationRun_startedAt_idx" ON "automationRun"("startedAt");

-- CreateIndex
CREATE INDEX "graphRunNode_runId_idx" ON "graphRunNode"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "graphRunNode_runId_nodeId_key" ON "graphRunNode"("runId", "nodeId");

-- CreateIndex
CREATE INDEX "automationStat_createdAt_idx" ON "automationStat"("createdAt");

-- CreateIndex
CREATE INDEX "vectorChunk_userId_collection_idx" ON "vectorChunk"("userId", "collection");

-- CreateIndex
CREATE INDEX "vectorChunk_userId_model_idx" ON "vectorChunk"("userId", "model");

-- CreateIndex
CREATE UNIQUE INDEX "skillRecord_name_key" ON "skillRecord"("name");

-- CreateIndex
CREATE INDEX "skillStat_name_createdAt_idx" ON "skillStat"("name", "createdAt");

-- CreateIndex
CREATE INDEX "libraryItem_parentId_idx" ON "libraryItem"("parentId");

-- CreateIndex
CREATE INDEX "libraryItem_userId_index" ON "libraryItem"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "idx_tool_permission_ws_tool" ON "toolPermission"("workspaceId", "toolName");

-- CreateIndex
CREATE INDEX "llmCallEvent_userId_createdAt_idx" ON "llmCallEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "toolCallEvent_userId_createdAt_idx" ON "toolCallEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "toolCallEvent_userId_toolName_idx" ON "toolCallEvent"("userId", "toolName");
