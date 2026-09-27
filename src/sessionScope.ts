import { createHmac, timingSafeEqual } from "node:crypto";

export type BrowserScope = { actorId: string; appSessionId: string; room: string };

export function roomGrant(token: string, rawKeys: string, identity: string, room: string, now = Date.now()) {
  const parts = token.split(".");
  if (parts.length !== 3 || !room || room.length > 120) throw new Error("room_grant_invalid");
  let header: any, claims: any;
  try { header = JSON.parse(Buffer.from(parts[0], "base64url").toString()); claims = JSON.parse(Buffer.from(parts[1], "base64url").toString()); }
  catch { throw new Error("room_grant_invalid"); }
  if (header.alg !== "HS256" || typeof claims.iss !== "string") throw new Error("room_grant_invalid");
  const pairs = rawKeys.split(/[\n,]/).map(s => s.trim()).filter(Boolean).map(line => {
    const split = line.includes(":") ? line.indexOf(":") : line.indexOf("=");
    return [line.slice(0, split).trim(), line.slice(split + 1).trim()];
  });
  const secret = pairs.find(([key]) => key === claims.iss)?.[1];
  if (!secret) throw new Error("room_grant_invalid");
  const expected = createHmac("sha256", secret).update(parts[0] + "." + parts[1]).digest();
  const signature = Buffer.from(parts[2], "base64url");
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) throw new Error("room_grant_invalid");
  if (claims.sub !== identity || claims.video?.room !== room || claims.video?.roomJoin !== true ||
      typeof claims.exp !== "number" || claims.exp * 1000 <= now ||
      (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf * 1000 > now))) {
    throw new Error("room_grant_invalid");
  }
  return room;
}

export async function verifiedBrowserScope(pool: any, sessionToken: string, roomToken: string, room: string, rawKeys: string): Promise<BrowserScope> {
  if (!pool || !sessionToken || !roomToken || !rawKeys) throw new Error("verified_session_and_room_required");
  const result = await pool.query(`select s.id as session_id, u.id as actor_id
    from control_store.app_sessions s join control_store.users u on u.id=s.user_id
    where s.token=$1 and s.revoked_at is null and s.expires_at>now()`, [sessionToken]);
  if (result.rows.length !== 1) throw new Error("app_session_invalid");
  const actorId = String(result.rows[0].actor_id);
  roomGrant(roomToken, rawKeys, actorId, room);
  return { actorId, appSessionId: String(result.rows[0].session_id), room };
}

export function sameBrowserScope(a: BrowserScope, b: BrowserScope) {
  return a.actorId === b.actorId && a.appSessionId === b.appSessionId && a.room === b.room;
}
