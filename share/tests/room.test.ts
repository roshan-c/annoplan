import {
  env,
  SELF,
  runInDurableObject,
  runDurableObjectAlarm,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { Env, ShareRoom } from "../src";
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}
const encrypted = "A".repeat(80);
let ip = 0;
async function call(
  path: string,
  method = "GET",
  input?: unknown,
  token?: string,
  address?: string,
) {
  return SELF.fetch(`https://example.com/api/shares${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": address ?? `test-${++ip}`,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
  });
}
async function create() {
  const r = await call("", "POST", {
    expires_in_seconds: 3600,
    encrypted_meta: encrypted,
  });
  expect(r.status).toBe(201);
  return r.json<{ shareId: string; ownerToken: string }>();
}
async function join(id: string) {
  const r = await call(`/${id}/join`, "POST", { encrypted_name: encrypted });
  expect(r.status).toBe(201);
  return r.json<{ participantId: string; participantToken: string }>();
}
const write = (
  id: string,
  ann: string,
  token: string,
  updated_at = new Date().toISOString(),
) =>
  call(
    `/${id}/annotations/${ann}`,
    "PUT",
    { ciphertext: encrypted, updated_at },
    token,
  );
describe("share public protocol", () => {
  it("creates, uploads and retrieves only ciphertext", async () => {
    const { shareId: id, ownerToken } = await create();
    expect((await call(`/${id}`)).status).toBe(200);
    const file = new Uint8Array(100).fill(42);
    const upload = await SELF.fetch(
      `https://example.com/api/shares/${id}/file`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          "Content-Length": "100",
        },
        body: file,
      },
    );
    expect(upload.status).toBe(200);
    expect(
      new Uint8Array(await (await call(`/${id}/file`)).arrayBuffer()),
    ).toEqual(file);
    const meta = await (
      await call(`/${id}`)
    ).json<{ encrypted_meta: string }>();
    expect(meta.encrypted_meta).toBe(encrypted);
  });
  it("joins, broadcasts, catches up, resolves old writes and enforces ownership", async () => {
    const { shareId: id, ownerToken } = await create(),
      sam = await join(id),
      lee = await join(id);
    const upgrade = await SELF.fetch(
      `https://example.com/api/shares/${id}/ws`,
      {
        headers: {
          Upgrade: "websocket",
          "Sec-WebSocket-Protocol": `annoplan, auth.${lee.participantToken}`,
        },
      },
    );
    expect(upgrade.status).toBe(101);
    const socket = upgrade.webSocket!;
    socket.accept();
    const messages: unknown[] = [];
    socket.addEventListener("message", (e) => {
      messages.push(JSON.parse(String(e.data)));
    });
    const ann = crypto.randomUUID(),
      time = new Date().toISOString();
    expect((await write(id, ann, sam.participantToken, time)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "upsert",
        annotation: expect.objectContaining({
          id: ann,
          participant_id: sam.participantId,
        }),
      }),
    );
    expect((await write(id, ann, lee.participantToken)).status).toBe(403);
    expect(
      (
        await call(
          `/${id}/annotations/${ann}`,
          "DELETE",
          { updated_at: time },
          ownerToken,
        )
      ).status,
    ).toBe(403);
    const stub = env.ROOMS.get(env.ROOMS.idFromName(id));
    await runInDurableObject(stub, async (_instance: ShareRoom, state) => {
      const stored = JSON.stringify(
        Array.from((await state.storage.list()).entries()),
      );
      expect(stored).not.toContain(ownerToken);
      expect(stored).not.toContain(sam.participantToken);
      expect(stored).not.toContain(lee.participantToken);
    });
    const own = crypto.randomUUID();
    await write(id, own, ownerToken);
    expect(
      (
        await call(
          `/${id}/annotations/${own}`,
          "DELETE",
          { updated_at: time },
          sam.participantToken,
        )
      ).status,
    ).toBe(403);
    const old = await write(
      id,
      ann,
      sam.participantToken,
      "2020-01-01T00:00:00.000Z",
    );
    expect((await old.json<{ updated_at: string }>()).updated_at).toBe(time);
    const changes = await (
      await call(`/${id}/annotations?since=0`)
    ).json<{ annotations: unknown[]; cursor: number }>();
    expect(changes.annotations).toHaveLength(2);
    expect(
      (
        await (
          await call(`/${id}/annotations?since=${changes.cursor}`)
        ).json<{ annotations: unknown[] }>()
      ).annotations,
    ).toEqual([]);
    const later = new Date(Date.parse(time) + 1).toISOString();
    expect(
      (
        await call(
          `/${id}/annotations/${ann}`,
          "DELETE",
          { updated_at: later },
          sam.participantToken,
        )
      ).status,
    ).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "delete",
        annotation: expect.objectContaining({ id: ann, deleted: true }),
      }),
    );
    const tombstones = await (
      await call(`/${id}/annotations?since=${changes.cursor}`)
    ).json<{ annotations: { deleted: boolean }[] }>();
    expect(tombstones.annotations[0].deleted).toBe(true);
    socket.close();
  });
  it("owner revokes and immediately deletes file and annotations", async () => {
    const { shareId: id, ownerToken } = await create(),
      sam = await join(id);
    await env.FILES.put(id, "ciphertext");
    await write(id, crypto.randomUUID(), ownerToken);
    expect(
      (await call(`/${id}`, "DELETE", undefined, sam.participantToken)).status,
    ).toBe(403);
    expect((await call(`/${id}`, "DELETE", undefined, ownerToken)).status).toBe(
      200,
    );
    expect((await call(`/${id}`)).status).toBe(410);
    expect(await env.FILES.head(id)).toBeNull();
    const stub = env.ROOMS.get(env.ROOMS.idFromName(id));
    await runInDurableObject(stub, async (_instance: ShareRoom, state) => {
      expect((await state.storage.list({ prefix: "a:" })).size).toBe(0);
      expect((await state.storage.list({ prefix: "p:" })).size).toBe(0);
    });
  });
  it("alarm deletes R2 and ALL storage; late requests also enforce expiry", async () => {
    for (const alarm of [true, false]) {
      const { shareId: id } = await create();
      await env.FILES.put(id, "encrypted file");
      const stub = env.ROOMS.get(env.ROOMS.idFromName(id));
      await runInDurableObject(stub, async (_instance: ShareRoom, state) => {
        const meta = await state.storage.get<Record<string, unknown>>("meta");
        await state.storage.put("meta", {
          ...meta,
          expires_at: Date.now() - 1,
        });
      });
      if (alarm) expect(await runDurableObjectAlarm(stub)).toBe(true);
      expect((await call(`/${id}`)).status).toBe(410);
      expect(await env.FILES.head(id)).toBeNull();
      await runInDurableObject(stub, async (_instance: ShareRoom, state) => {
        expect((await state.storage.list()).size).toBe(0);
        expect(await state.storage.getAlarm()).toBeNull();
      });
    }
    expect(
      (await call(`/${crypto.randomUUID()}.${Date.now() - 1000}`)).status,
    ).toBe(410);
  });
  it("bounds lifetime, file size, payload, participants, annotations and per-IP requests", async () => {
    for (const seconds of [3599, 86401])
      expect(
        (
          await call("", "POST", {
            expires_in_seconds: seconds,
            encrypted_meta: encrypted,
          })
        ).status,
      ).toBe(400);
    const { shareId: id, ownerToken } = await create();
    expect(
      (
        await SELF.fetch(`https://example.com/api/shares/${id}/file`, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            "Content-Length": String(51 * 1024 * 1024),
          },
          body: "x",
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await call(
          `/${id}/annotations/${crypto.randomUUID()}`,
          "PUT",
          {
            updated_at: new Date().toISOString(),
            ciphertext: "A".repeat(350000),
          },
          ownerToken,
        )
      ).status,
    ).toBe(400);
    const stub = env.ROOMS.get(env.ROOMS.idFromName(id));
    await runInDurableObject(stub, async (_instance: ShareRoom, state) => {
      const participants: Record<string, unknown> = {};
      for (let i = 0; i < 50; i++)
        participants[`p:${i}`] = {
          id: String(i),
          encrypted_name: encrypted,
          token_hash: "hash",
        };
      await state.storage.put(participants);
      const annotations: Record<string, unknown> = {};
      for (let i = 0; i < 2000; i++) annotations[`a:${i}`] = { id: String(i) };
      await state.storage.put(annotations);
    });
    expect(
      (await call(`/${id}/join`, "POST", { encrypted_name: encrypted })).status,
    ).toBe(409);
    expect((await write(id, crypto.randomUUID(), ownerToken)).status).toBe(409);
    const fresh = await create();
    for (let i = 0; i < 20; i++)
      expect(
        (
          await call(
            `/${fresh.shareId}/join`,
            "POST",
            { encrypted_name: encrypted },
            undefined,
            "same-ip",
          )
        ).status,
      ).toBe(201);
    expect(
      (
        await call(
          `/${fresh.shareId}/join`,
          "POST",
          { encrypted_name: encrypted },
          undefined,
          "same-ip",
        )
      ).status,
    ).toBe(429);
  });
});

it("updates encrypted owner metadata only with owner authority and preserves owner-side agent ownership", async () => {
  const { shareId: id, ownerToken } = await create();
  const sam = await join(id);
  const changed = "B".repeat(80);
  expect(
    (
      await call(
        `/${id}`,
        "PUT",
        { encrypted_meta: changed },
        sam.participantToken,
      )
    ).status,
  ).toBe(403);
  expect(
    (await call(`/${id}`, "PUT", { encrypted_meta: changed }, ownerToken))
      .status,
  ).toBe(200);
  expect(await (await call(`/${id}`)).json()).toMatchObject({
    encrypted_meta: changed,
  });
  const agent = crypto.randomUUID();
  // Large encrypted agent notes remain opaque and owner-authenticated.
  const ciphertext = "A".repeat(280000);
  const result = await call(
    `/${id}/annotations/${agent}`,
    "PUT",
    { ciphertext, updated_at: new Date().toISOString() },
    ownerToken,
  );
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({
    participant_id: "owner",
    ciphertext,
  });
  expect((await write(id, agent, sam.participantToken)).status).toBe(403);
  expect(
    (
      await call(
        `/${id}/annotations/${agent}`,
        "DELETE",
        { updated_at: new Date().toISOString() },
        sam.participantToken,
      )
    ).status,
  ).toBe(403);
});
