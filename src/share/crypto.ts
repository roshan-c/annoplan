/** Wire format: version 1 byte, random 96-bit IV, AES-GCM ciphertext + 128-bit tag. */
export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
export function unbase64url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error("Invalid encrypted data");
  return Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
}
export async function generateKey(): Promise<string> {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}
async function key(value: string) {
  const bytes = unbase64url(value);
  if (bytes.length !== 32) throw new Error("Invalid share key");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
/** Context binds ciphertext to its role and annotation UUID, preventing substitution. */
export async function encryptBytes(
  secret: string,
  bytes: Uint8Array,
  context: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context) },
    await key(secret),
    new Uint8Array(bytes),
  );
  const envelope = new Uint8Array(13 + encrypted.byteLength);
  envelope[0] = 1;
  envelope.set(iv, 1);
  envelope.set(new Uint8Array(encrypted), 13);
  return envelope;
}
export async function decryptBytes(
  secret: string,
  envelope: Uint8Array,
  context: string,
): Promise<Uint8Array<ArrayBuffer>> {
  if (envelope[0] !== 1 || envelope.length < 29)
    throw new Error("Invalid encrypted data");
  return new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: new Uint8Array(envelope.slice(1, 13)),
        additionalData: new TextEncoder().encode(context),
      },
      await key(secret),
      new Uint8Array(envelope.slice(13)),
    ),
  );
}
export async function encryptJson(
  secret: string,
  value: unknown,
  context: string,
) {
  return base64url(
    await encryptBytes(
      secret,
      new TextEncoder().encode(JSON.stringify(value)),
      context,
    ),
  );
}
export async function decryptJson<T>(
  secret: string,
  value: string,
  context: string,
): Promise<T> {
  return JSON.parse(
    new TextDecoder().decode(
      await decryptBytes(secret, unbase64url(value), context),
    ),
  ) as T;
}
