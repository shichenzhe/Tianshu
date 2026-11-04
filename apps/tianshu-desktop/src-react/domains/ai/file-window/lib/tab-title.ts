/**
 * resource → tab 标题：workspace 取 basename（同 detail-panel file tab）、
 * library 先以 #itemId 占位（Task 14 载入条目名后 patchTab title）。
 */
import type { FileWindowResource } from "../model/resource";

export function titleOfResource(resource: FileWindowResource): string {
  if (resource.kind === "workspace")
    return resource.path.split("/").pop() || resource.path;
  return `#${resource.itemId}`;
}
