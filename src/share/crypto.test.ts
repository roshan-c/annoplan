import { expect, it } from "vitest";
import {
  generateKey,
  encryptBytes,
  decryptBytes,
  encryptJson,
  decryptJson,
} from "./crypto";
it("round-trips binary files and JSON with unique IVs", async () => {
  const key = await generateKey(),
    bytes = new Uint8Array([0, 255, 127]);
  const a = await encryptBytes(key, bytes, "file");
  expect(await decryptBytes(key, a, "file")).toEqual(bytes);
  expect(await encryptBytes(key, bytes, "file")).not.toEqual(a);
  const value = { quote: "Hello 🌍", note: null };
  expect(
    await decryptJson(
      key,
      await encryptJson(key, value, "annotation:a"),
      "annotation:a",
    ),
  ).toEqual(value);
});
it("rejects a wrong key, ciphertext tampering and context substitution", async () => {
  const key = await generateKey(),
    encrypted = await encryptBytes(key, new Uint8Array([42]), "file");
  await expect(
    decryptBytes(await generateKey(), encrypted, "file"),
  ).rejects.toThrow();
  await expect(decryptBytes(key, encrypted, "meta")).rejects.toThrow();
  encrypted[encrypted.length - 1] ^= 1;
  await expect(decryptBytes(key, encrypted, "file")).rejects.toThrow();
});
