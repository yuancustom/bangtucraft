import { expect, it } from "vitest";
import { paidApprovalReason, requiresApproval } from "./approval-policy.ts";

it("本地自动执行覆盖命令、外部只读与依赖安装；手动模式保留原批准规则", () => {
  for (const tool of ["local_command_execute", "local_file_read", "local_file_stat", "local_directory_list", "python_install_packages"]) {
    expect(requiresApproval(tool, "full-access", false)).toBe(false);
    expect(requiresApproval(tool, "request", false)).toBe(true);
  }
  expect(requiresApproval("local_command_execute", "request", true)).toBe(false);
});

it("专业识别、图元下载与截图在所有权限模式和Skill状态下仍需逐次确认", () => {
  for (const prefix of ["bangtu_", ""]) {
    for (const tool of ["create_architecture_task", "create_structure_task", "create_electrical_task", "create_hvac_task", "create_plumbing_task", "get_frame_entities_download_url", "capture_screenshot_in_frame"]) {
      expect(paidApprovalReason(prefix + tool)).toContain("币");
      for (const mode of ["request", "full-access"] as const) {
        expect(requiresApproval(prefix + tool, mode, true)).toBe(true);
      }
    }
  }
  for (const tool of ["bangtu_create_dwg_task", "bangtu_create_electrical_pre_task", "bangtu_get_task_status", "bangtu_get_frame_result"]) {
    expect(requiresApproval(tool, "full-access", true)).toBe(false);
  }
});
