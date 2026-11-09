// 清理运行数据中意外落库的密钥：把 data/users/*/agent.db 里所有出现 .env 密钥值的文本替换为 [REDACTED]。
// 需在服务停止后运行：node scripts/scrub-secrets.mjs
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "..");
const env = fs.readFileSync(path.join(root, ".env"), "utf8");
const keys = [...env.matchAll(/^[A-Z_]*(KEY|SECRET|TOKEN)=(.+)$/gm)].map((m) => m[2].trim()).filter((k) => k.length >= 8);
const usersDir = path.join(root, "data", "users");
let total = 0;
for (const uid of fs.existsSync(usersDir) ? fs.readdirSync(usersDir) : []) {
  for (const file of ["agent.db", "app.db"]) {
    const dbFile = path.join(usersDir, uid, file);
    if (!fs.existsSync(dbFile)) continue;
    const db = new DatabaseSync(dbFile);
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
      for (const { name: col, type } of db.prepare(`PRAGMA table_info("${name}")`).all()) {
        if (type && !/TEXT|JSON|CLOB|^$/i.test(type)) continue;
        for (const k of keys) {
          const r = db.prepare(`UPDATE "${name}" SET "${col}" = replace("${col}", ?, '[REDACTED]') WHERE typeof("${col}") = 'text' AND instr("${col}", ?) > 0`).run(k, k);
          if (r.changes) {
            total += Number(r.changes);
            console.log(`${uid}/${file} ${name}.${col}: ${r.changes} 行`);
          }
        }
      }
    }
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    // 已删除内容仍可能留在空闲页里，VACUUM 重写整个文件。
    db.exec("VACUUM");
    db.close();
  }
}
console.log(`共清理 ${total} 处`);
