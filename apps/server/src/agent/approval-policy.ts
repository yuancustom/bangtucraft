import type { PermissionMode } from "@drawing-agent/shared";

/** 帮图已知付费工具：不受本地自动执行或 Skill 免批影响。 */
export function paidApprovalReason(toolName: string): string | undefined {
  const name = toolName.replace(/^bangtu_/, "");
  if (/^create_(architecture|structure|electrical|hvac|plumbing)_task$/.test(name)) return "帮图付费专业识别：1 币/图框";
  if (name === "get_frame_entities_download_url") return "帮图付费图元下载：0.05 币/次";
  if (name === "capture_screenshot_in_frame") return "帮图付费截图：0.01 币/次";
  return undefined;
}

export function requiresApproval(toolName: string, mode: PermissionMode, skillActive: boolean): boolean {
  if (paidApprovalReason(toolName)) return true;
  if (mode === "full-access") return false;
  if (["python_install_packages", "local_file_stat", "local_directory_list", "local_file_read"].includes(toolName)) return true;
  return toolName === "local_command_execute" && !skillActive;
}
