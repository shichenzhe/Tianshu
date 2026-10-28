// packages/tianshu-protocol/src/library-contract.ts
/** A5 资料库批自桌面 library.api.ts 收编（单份权威源）。
 *  远程 DTO 刻意剔除 storagePath/originalPath——本机绝对路径不作远程
 *  读取凭证；内容读取只走 library/read(readImage)，服务端校验归属后
 *  自行解析 {libraryRoot}/{id}/{name} 磁盘路径。 */

export type LibraryItemKind = "folder" | "file" | "link";

/** 资料库条目远程 DTO（location 为面包屑名段，同桌面端语义） */
export interface LibraryItemDto {
  id: number;
  parentId: number | null;
  name: string;
  kind: LibraryItemKind;
  fileType: string | null;
  mimeType: string | null;
  size: number | null;
  url: string | null;
  favorite: boolean;
  lastViewedAt: string | null;
  location: string[];
  createdAt: string;
  updatedAt: string;
}

/** library/list 出参：当前目录条目 + 自根至当前目录的面包屑 */
export interface LibraryListResult {
  items: LibraryItemDto[];
  breadcrumbs: LibraryItemDto[];
}

export interface LibraryCreateFolderPayload {
  name: string;
  parentId: number | null;
}

/** 新建文件（移动端固定 .md；服务端校验 name 非空并保留扩展名语义） */
export interface LibraryCreateFilePayload {
  name: string;
  parentId: number | null;
}

/** 仅允许 http/https——服务端守卫（与桌面 addLink 同口径） */
export interface LibraryAddLinkPayload {
  url: string;
  title: string | null;
  parentId: number | null;
}

export interface LibraryRenamePayload {
  id: number;
  name: string;
}

/** targetParentId=null 移到根（服务端拒绝移动到自身/后代，同桌面 move） */
export interface LibraryMovePayload {
  ids: number[];
  targetParentId: number | null;
}

export interface LibraryDeletePayload {
  ids: number[];
}

export interface LibraryIdPayload {
  id: number;
}

/** library/read 出参：仅文本类（512KB/NUL 二进制守卫由服务端执行） */
export interface LibraryReadResult {
  kind: "text";
  content: string;
}

/** library/writeContent 载荷：全量覆写文本内容（非 diff；≤512KiB 服务端
 *  守卫对齐 read 口径；v1 无乐观锁，最后写赢） */
export interface LibraryWriteContentPayload {
  id: number;
  content: string;
}

/** library/uploadFile 载荷：移动端二进制入库（base64 zip 同 skills
 *  installUpload 口径——原始 ≤3MB，relay 单帧 4MiB 余量；parentId 缺省根
 *  目录；落盘 {libraryDir}/{id}/{name}，fileType/mime 经扩展名分类表推断，
 *  源记 "upload"） */
export interface LibraryUploadFilePayload {
  parentId?: number;
  name: string;
  base64: string;
}

/** library/readImage 出参（mime 白名单 png/jpg/jpeg/webp/gif/svg+xml，10MB
 *  上限；A5 尾：svg 为文本型图像，base64 后移动端 WebView data URL 可渲染；
 *  bmp/ico 不扩——RN Image 跨平台支持差，移动端前置拦截） */
export interface LibraryReadImageResult {
  mime: string;
  dataBase64: string;
}

/** library 稳定错误码（服务端实现透传，移动端按码提示） */
export const LIBRARY_ERROR_CODES = [
  "LIBRARY_NOT_FOUND",
  "LIBRARY_NOT_FILE",
  "LIBRARY_TOO_LARGE",
  "LIBRARY_BINARY",
  "LIBRARY_READ_FAILED",
  // 资料库编辑批：写盘失败独立码（读失败仍走 LIBRARY_READ_FAILED）
  "LIBRARY_WRITE_FAILED",
  // 资料库上传批：坏 base64/超 3MB/文件名非法（同 skills SKILL_UPLOAD_INVALID 口径）
  "LIBRARY_UPLOAD_INVALID",
] as const;
export type LibraryErrorCode = (typeof LIBRARY_ERROR_CODES)[number];
