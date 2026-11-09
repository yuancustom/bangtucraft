import { useState } from "react";
import type { ModelInfo } from "@drawing-agent/shared";
import { api } from "../api.ts";

export function ModelsPage({ models, roles }: { models: ModelInfo[]; roles: Record<string, string> }) {
  const [results, setResults] = useState<Record<string, string>>({});
  const [discovered, setDiscovered] = useState<Record<string, string>>({});
  const ping = async (id: string) => {
    setResults((r) => ({ ...r, [id]: "测试中…" }));
    const r = await api.ping(id).catch((e: Error) => ({ ok: false, error: e.message }) as { ok: boolean; error?: string; latencyMs?: number; reply?: string });
    setResults((x) => ({ ...x, [id]: r.ok ? `✓ ${r.latencyMs} ms：${r.reply}` : `✗ ${r.error}` }));
  };
  const discover = async (provider: string) => {
    setDiscovered((d) => ({ ...d, [provider]: "查询中…" }));
    const r = await api.discover(provider).catch((e: Error) => ({ models: [`失败：${e.message}`] }));
    setDiscovered((d) => ({ ...d, [provider]: r.models.join("、") }));
  };
  const providers = [...new Set(models.map((m) => m.provider))];
  return (
    <div className="page">
      <h2>模型</h2>
      <p className="muted">自动模式下按任务难度选择：L1 简单任务、L2 一般多步任务、L3 复杂规划与看图；运行中遇到连续失败等情况会自动升档。</p>
      <table className="table">
        <thead>
          <tr>
            <th>档位</th>
            <th>模型</th>
            <th>接入点</th>
            <th>能力</th>
            <th>连通性</th>
          </tr>
        </thead>
        <tbody>
          {models.map((m) => (
            <tr key={m.id}>
              <td>{m.tier}</td>
              <td>
                {m.name}
                <div className="muted">{m.id}</div>
              </td>
              <td>{m.provider}</td>
              <td>{[m.capabilities.tools && "工具", m.capabilities.images && "图片", m.capabilities.reasoning && "推理"].filter(Boolean).join("、")}</td>
              <td>
                <button onClick={() => void ping(m.id)}>测试</button> <span className="muted">{results[m.id]}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>角色分配</h3>
      <div className="chips">
        {Object.entries(roles).map(([role, id]) => (
          <span key={role} className="chip">
            {role}：{id}
          </span>
        ))}
      </div>
      <h3>接入点可用模型</h3>
      {providers.map((p) => (
        <div key={p} className="row">
          <button onClick={() => void discover(p)}>列出 {p} 的模型</button>
          <span className="muted">{discovered[p]}</span>
        </div>
      ))}
    </div>
  );
}
