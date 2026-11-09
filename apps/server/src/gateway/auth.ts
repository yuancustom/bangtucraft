import { createHash, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { createClient, type Client } from "@libsql/client";

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

export const MAX_USERS = 3;
const SESSION_TTL_MS = 30 * 24 * 3600_000;
const USERNAME = /^[A-Za-z0-9_\u4e00-\u9fa5-]{2,32}$/;

export interface User {
  id: string;
  username: string;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 403 | 409 = 400,
  ) {
    super(message);
  }
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, key] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !key) return false;
  const expected = Buffer.from(key, "base64");
  const actual = await scrypt(password, Buffer.from(salt, "base64"), expected.length);
  return timingSafeEqual(actual, expected);
}

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

/** 本地账号（≤3 个）与登录会话，存在 data/identity.db。 */
export class AuthStore {
  private client: Client;
  private ready: Promise<void>;

  constructor(file: string) {
    this.client = createClient({ url: `file:${file}` });
    this.ready = this.client
      .batch(
        [
          `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL)`,
          `CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL)`,
        ],
        "write",
      )
      .then(() => undefined);
  }

  async userCount(): Promise<number> {
    await this.ready;
    const r = await this.client.execute("SELECT COUNT(*) AS n FROM users");
    return Number(r.rows[0]!.n);
  }

  async register(username: string, password: string): Promise<User> {
    await this.ready;
    if (!USERNAME.test(username)) throw new AuthError("用户名需为 2–32 位字母、数字、中文、下划线或连字符");
    if (password.length < 8 || password.length > 128) throw new AuthError("密码长度需为 8–128 位");
    if ((await this.userCount()) >= MAX_USERS) throw new AuthError(`最多只能注册 ${MAX_USERS} 个账号`, 403);
    const id = randomUUID();
    try {
      await this.client.execute({
        sql: "INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)",
        args: [id, username, await hashPassword(password), new Date().toISOString()],
      });
    } catch {
      throw new AuthError("用户名已存在", 409);
    }
    return { id, username };
  }

  async login(username: string, password: string): Promise<{ user: User; token: string }> {
    await this.ready;
    const r = await this.client.execute({ sql: "SELECT id, username, password_hash FROM users WHERE username = ?", args: [username] });
    const row = r.rows[0];
    if (!row || !(await verifyPassword(password, String(row.password_hash)))) {
      throw new AuthError("用户名或密码错误", 401);
    }
    const token = randomBytes(32).toString("base64url");
    await this.client.execute({
      sql: "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
      args: [tokenHash(token), String(row.id), Date.now() + SESSION_TTL_MS],
    });
    return { user: { id: String(row.id), username: String(row.username) }, token };
  }

  async userForToken(token: string | undefined): Promise<User | undefined> {
    if (!token) return undefined;
    await this.ready;
    const r = await this.client.execute({
      sql: "SELECT u.id, u.username, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?",
      args: [tokenHash(token)],
    });
    const row = r.rows[0];
    if (!row || Number(row.expires_at) < Date.now()) return undefined;
    return { id: String(row.id), username: String(row.username) };
  }

  async logout(token: string | undefined) {
    if (!token) return;
    await this.ready;
    await this.client.execute({ sql: "DELETE FROM sessions WHERE token_hash = ?", args: [tokenHash(token)] });
  }

  close() {
    this.client.close();
  }
}
