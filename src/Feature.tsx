import { useEffect, useMemo, useState } from "react";
import * as Y from "yjs";
import {
  PersonalQR,
  makeScanPayload,
  useRoomSeal,
  type MeshConfig,
  type YRoom,
} from "@baditaflorin/mesh-common";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const CHUNK_BYTES = 8 * 1024;
const DROP_TTL_MS = 15 * 60 * 1000;
const RECORDS_KEY = "mesh-privacy-drop:records";
const CHUNKS_KEY = "mesh-privacy-drop:chunks";

export type EncryptedDrop = {
  id: string;
  createdAt: number;
  expiresAt: number;
  chunks: number;
  sealedMetadata: string;
};

type DropMetadata = { name: string; mimeType: string; size: number };
type DisplayDrop = EncryptedDrop & { metadata: DropMetadata | null; complete: boolean };
type Props = { room: YRoom | null; roomId?: string; config: MeshConfig };

function bytesToId(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createDropPassphrase(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return (
    bytesToId(bytes)
      .match(/.{1,4}/g)
      ?.join("-") ?? ""
  );
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function isExpired(expiresAt: number, now = Date.now()): boolean {
  return !Number.isFinite(expiresAt) || expiresAt <= now;
}

function parseMetadata(
  sealedMetadata: string,
  decryptText: (value: string) => string | null,
): DropMetadata | null {
  try {
    const decoded = decryptText(sealedMetadata);
    if (!decoded) return null;
    const value = JSON.parse(decoded) as Partial<DropMetadata>;
    const { name, mimeType, size } = value;
    if (
      typeof name !== "string" ||
      typeof mimeType !== "string" ||
      typeof size !== "number" ||
      !Number.isFinite(size) ||
      size < 0
    ) {
      return null;
    }
    return { name, mimeType, size };
  } catch {
    return null;
  }
}

function asDrop(value: unknown): EncryptedDrop | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<EncryptedDrop>;
  const { id, sealedMetadata, createdAt, expiresAt, chunks } = item;
  if (
    typeof id !== "string" ||
    typeof sealedMetadata !== "string" ||
    typeof createdAt !== "number" ||
    !Number.isFinite(createdAt) ||
    typeof expiresAt !== "number" ||
    !Number.isFinite(expiresAt) ||
    typeof chunks !== "number" ||
    !Number.isInteger(chunks) ||
    chunks < 1
  ) {
    return null;
  }
  return item as EncryptedDrop;
}

export function Feature({ room, roomId = "default", config }: Props) {
  const [passphrase, setPassphrase] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const seal = useRoomSeal(passphrase ? { roomId, passphrase } : null);

  useEffect(() => {
    if (!room) return;
    const records = room.doc.getMap<EncryptedDrop>(RECORDS_KEY);
    const chunks = room.doc.getMap<Y.Array<string>>(CHUNKS_KEY);
    const update = () => setRevision((value) => value + 1);
    records.observeDeep(update);
    chunks.observeDeep(update);
    return () => {
      records.unobserveDeep(update);
      chunks.unobserveDeep(update);
    };
  }, [room]);

  const drops = useMemo<DisplayDrop[]>(() => {
    if (!room) return [];
    const records = room.doc.getMap<EncryptedDrop>(RECORDS_KEY);
    const chunks = room.doc.getMap<Y.Array<string>>(CHUNKS_KEY);
    const now = Date.now();
    return Array.from(records.values())
      .map(asDrop)
      .filter((drop): drop is EncryptedDrop => Boolean(drop) && !isExpired(drop!.expiresAt, now))
      .map((drop) => ({
        ...drop,
        metadata: seal.ready
          ? parseMetadata(drop.sealedMetadata, (sealedMetadata) => seal.decryptText(sealedMetadata))
          : null,
        complete:
          chunks.get(drop.id) instanceof Y.Array && chunks.get(drop.id)!.length === drop.chunks,
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [room, revision, seal]);

  useEffect(() => {
    if (!room) return;
    const records = room.doc.getMap<EncryptedDrop>(RECORDS_KEY);
    const chunks = room.doc.getMap<Y.Array<string>>(CHUNKS_KEY);
    const prune = () => {
      const now = Date.now();
      const expired = Array.from(records.entries())
        .map(([id, value]) => ({ id, drop: asDrop(value) }))
        .filter(({ drop }) => !drop || isExpired(drop.expiresAt, now));
      if (!expired.length) return;
      room.doc.transact(() => {
        for (const { id } of expired) {
          records.delete(id);
          chunks.delete(id);
        }
      });
    };
    prune();
    const timer = window.setInterval(prune, 15_000);
    return () => window.clearInterval(timer);
  }, [room]);

  const qrPayload = room ? makeScanPayload(roomId, room.peerId, "privacy-drop") : "";

  const send = async () => {
    if (!room || !file || !seal.ready) return;
    if (file.size > MAX_FILE_BYTES) {
      setNotice(`Choose a file under ${formatBytes(MAX_FILE_BYTES)}.`);
      return;
    }
    setNotice("Encrypting and sending…");
    try {
      const id = bytesToId(crypto.getRandomValues(new Uint8Array(8)));
      const bytes = new Uint8Array(await file.arrayBuffer());
      const total = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES));
      const encryptedChunks = new Y.Array<string>();
      const record: EncryptedDrop = {
        id,
        createdAt: Date.now(),
        expiresAt: Date.now() + DROP_TTL_MS,
        chunks: total,
        sealedMetadata: seal.encrypt(
          JSON.stringify({
            name: file.name,
            mimeType: file.type || "application/octet-stream",
            size: file.size,
          }),
        ),
      };
      const records = room.doc.getMap<EncryptedDrop>(RECORDS_KEY);
      const chunks = room.doc.getMap<Y.Array<string>>(CHUNKS_KEY);
      room.doc.transact(() => {
        records.set(id, record);
        chunks.set(id, encryptedChunks);
      });
      for (
        let offset = 0;
        offset < bytes.length || (bytes.length === 0 && offset === 0);
        offset += CHUNK_BYTES
      ) {
        const end = Math.min(bytes.length, offset + CHUNK_BYTES);
        encryptedChunks.push([seal.encrypt(bytes.slice(offset, end))]);
        if (bytes.length === 0) break;
      }
      setFile(null);
      setNotice("Encrypted drop is live for 15 minutes.");
    } catch {
      setNotice("The file could not be encrypted. Try again.");
    }
  };

  const download = (drop: DisplayDrop) => {
    if (!room || !seal.ready || !drop.metadata || !drop.complete) return;
    const encryptedChunks = room.doc.getMap<Y.Array<string>>(CHUNKS_KEY).get(drop.id);
    if (!(encryptedChunks instanceof Y.Array)) return;
    const parts: BlobPart[] = [];
    for (const encrypted of encryptedChunks.toArray()) {
      const plain = seal.decrypt(encrypted);
      if (!plain) {
        setNotice("Could not decrypt this drop. Check that the room secret matches.");
        return;
      }
      parts.push(new Uint8Array(plain));
    }
    const objectUrl = URL.createObjectURL(new Blob(parts, { type: drop.metadata.mimeType }));
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = drop.metadata.name;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 5_000);
  };

  const remove = (id: string) => {
    if (!room) return;
    room.doc.transact(() => {
      room.doc.getMap<EncryptedDrop>(RECORDS_KEY).delete(id);
      room.doc.getMap<Y.Array<string>>(CHUNKS_KEY).delete(id);
    });
  };

  return (
    <main className="drop-page">
      <section className="drop-hero" aria-labelledby="drop-title">
        <p className="eyebrow">Mesh Privacy Drop</p>
        <h1 id="drop-title">Pass a file. Leave no trail.</h1>
        <p>
          Scan the room QR, say the short secret out loud, and send a small file directly between
          browsers. The filename and file bytes are encrypted before they enter the shared room.
        </p>
        <span className={`connection ${room ? "is-ready" : ""}`}>
          <span aria-hidden="true" />{" "}
          {room
            ? `${room.peerCount} peer${room.peerCount === 1 ? "" : "s"} in room`
            : "Connecting to room…"}
        </span>
      </section>

      <section className="drop-grid" aria-label="Encrypted file transfer">
        <article className="drop-card secret-card">
          <p className="eyebrow">1. Pair privately</p>
          <h2>Room secret</h2>
          <p className="muted">
            The QR joins the room only. Never put this secret in a link, chat, or screenshot.
          </p>
          <div className="secret-controls">
            <input
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              placeholder="Enter or generate a secret"
              aria-label="Room secret"
              autoComplete="off"
              spellCheck="false"
            />
            <button type="button" onClick={() => setPassphrase(createDropPassphrase())}>
              Generate
            </button>
          </div>
          {passphrase && (
            <p className="fingerprint">
              {seal.ready ? `Key check: ${seal.fingerprint}` : "Deriving encryption key…"}
            </p>
          )}
          {qrPayload && (
            <div className="pairing">
              <PersonalQR payload={qrPayload} size={156} ariaLabel="Room join QR code" />
              <p>Scan this QR with the receiving device, then type the same room secret there.</p>
            </div>
          )}
        </article>

        <article className="drop-card send-card">
          <p className="eyebrow">2. Send encrypted</p>
          <h2>Drop a small file</h2>
          <label className="file-picker">
            <input type="file" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
            <span>
              {file ? `${file.name} · ${formatBytes(file.size)}` : "Choose a file (up to 2 MB)"}
            </span>
          </label>
          <button
            className="primary-action"
            type="button"
            onClick={() => void send()}
            disabled={!room || !file || !seal.ready}
          >
            Encrypt & send
          </button>
          <p className="muted">
            Drops expire for everyone after 15 minutes. Nothing is uploaded to an app server.
          </p>
          {notice && (
            <p className="notice" role="status">
              {notice}
            </p>
          )}
        </article>
      </section>

      <section className="drop-card inbox" aria-labelledby="inbox-title">
        <div>
          <p className="eyebrow">3. Receive</p>
          <h2 id="inbox-title">Live drops</h2>
        </div>
        {!passphrase && (
          <p className="empty">Enter the room secret to reveal file names and downloads.</p>
        )}
        {passphrase && drops.length === 0 && (
          <p className="empty">No active drops. Files vanish from the room after 15 minutes.</p>
        )}
        {drops.map((drop) => (
          <article className="drop-row" key={drop.id}>
            <div>
              <strong>{drop.metadata?.name ?? "Encrypted file"}</strong>
              <span>
                {drop.metadata
                  ? `${formatBytes(drop.metadata.size)} · expires soon`
                  : "Waiting for matching room secret"}
              </span>
            </div>
            <div className="row-actions">
              <button
                type="button"
                onClick={() => download(drop)}
                disabled={!drop.metadata || !drop.complete}
              >
                Download
              </button>
              <button type="button" className="quiet" onClick={() => remove(drop.id)}>
                Remove
              </button>
            </div>
          </article>
        ))}
      </section>

      <p className="security-note">
        Encryption protects filenames and bytes in the room. Timing, encrypted size, and room
        membership are still visible to room peers.
      </p>
    </main>
  );
}
